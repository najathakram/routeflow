#!/usr/bin/env node
// dry-run.mjs — executes pipeline.js with STUBBED Workflow globals. Zero API calls.
//
// The Workflow runtime injects `agent`, `parallel`, `pipeline`, `log`, `phase`, `args`,
// `budget`, `workflow`. This harness injects fakes, feeds canned agent results keyed by
// the agent label, and asserts the control flow the engine promises: effort on every
// call, the two-level red verdict, the lazy refutation slate, the overlapped phases, the
// final-pass skip and fallback, the hollow-gate rule, and the pricing fields. Run it
// after ANY edit to pipeline.js — `node --check` proves syntax, this proves the branches.
//
//   node scripts/dry-run.mjs            # all scenarios
//   node scripts/dry-run.mjs --calls    # also print every agent call (label, model, effort)
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const src = fs
  .readFileSync(path.join(here, '..', 'pipeline.js'), 'utf8')
  .replace(/^export const meta = \{/m, 'const meta = {')
const showCalls = process.argv.includes('--calls')

const HEX = 'a'.repeat(64)
// A stale pre-probe baseline (HEX2) versus what the file actually holds (HEX3).
const HEX2 = 'b'.repeat(64)
const HEX3 = 'c'.repeat(64)
const done = (files) => ({ status: 'done', filesChanged: files, deviations: '', notes: '' })
const green = (cmds, executed = 5) => ({ pass: true, results: cmds.map((c) => ({ command: c, pass: true, summary: 'ok', executed })) })
// What the bugfix-mode radius packer hands every review lens.
const PACK_TEXT = 'RADIUS: src/a.ts\n@@ -10,3 +10,4 @@\n-  return qty * price\n+  return roundMoney(qty * price)\nexport function computeLineSubtotal(...)\nsrc/b.ts:44 — computeLineSubtotal(line)'
// A red gate that met BOTH bars, so a bugfix-mode scenario can exercise a later phase
// without the behavioral-bar finding (which bugfix mode deliberately raises) in the way.
const REDDEST = { structurallyRed: true, behaviorallyRed: true, properlyRed: true, tests: [], blockers: [], remediation: '' }

// The fix planner's prompt lists one block per finding under "Findings to decide:",
// each opening with its own [#i] marker. Split the section into those blocks so a
// responder can decide per finding from what the engine actually told the planner.
function planSection(prompt) {
  const marker = 'Findings to decide:'
  const at = prompt.indexOf(marker)
  if (at === -1) return []
  return prompt
    .slice(at + marker.length)
    .split(/(?=\[#\d+\])/)
    .filter((p) => /^\[#\d+\]/.test(p))
}

// Canned responder: label prefix -> result. `overrides` lets a scenario change one answer.
function responder(s) {
  return (label, opts, prompt) => {
    const o = s.overrides || {}
    for (const k of Object.keys(o)) if (label.startsWith(k)) return typeof o[k] === 'function' ? o[k](label, opts, prompt) : o[k]
    if (label === 'baseline-gate') return green(s.commands)
    if (label === 'baseline-grounding') return { findings: [] }
    if (label === 'baseline-manifest') return { files: s.manifest, validCommands: s.commands, artifacts: [] }
    if (label.startsWith('tests:')) return done(['src/a.spec.ts'])
    if (label.startsWith('red-run')) return { ran: true, results: [{ command: 'jest a', exitCode: 1, output: '3 failed' }] }
    if (label.startsWith('red-audit')) return { structurallyRed: true, behaviorallyRed: false, properlyRed: false, tests: [], blockers: ['BEHAVIORAL: all fail on undefined'], remediation: '' }
    if (label.startsWith('red-remediate')) return { fixed: [], skipped: [], filesChanged: [] }
    if (label.startsWith('impl:')) return done(['src/a.ts'])
    if (label === 'gate' || label.startsWith('regate') || label === 'final-gate') return green(s.commands)
    if (label.startsWith('build-fix')) return { fixed: [], skipped: [], filesChanged: [] }
    if (label.startsWith('review:')) return { findings: s.reviewFindings || [] }
    if (label === 'location-check') {
      const n = (prompt.match(/\[#\d+\]/g) || []).length
      return { checks: Array.from({ length: n }, (_, i) => ({ index: i, locationValid: !(s.invalidIndexes || []).includes(i), note: '' })) }
    }
    if (label.startsWith('refute-batch:')) {
      const n = (prompt.match(/\[#\d+\]/g) || []).length
      const refuted = opts.phase === 'Fix' ? !!s.disputeRefuted : !!s.firstRefuted
      return { verdicts: Array.from({ length: n }, (_, i) => ({ index: i, refuted, reason: 'batch' })) }
    }
    if (label.startsWith('refute1')) return { refuted: !!s.firstRefuted, reason: 'first' }
    if (label.startsWith('refute2')) return { refuted: !!s.secondRefuted, reason: 'second' }
    if (label.startsWith('tiebreak')) return { refuted: !!s.judgeRefuted, reason: 'judge' }
    if (label === 'ui-drive' || label === 'ui-redrive') {
      const flows = (s.args.uiVerify && s.args.uiVerify.flows) || ['default flow']
      return { completed: true, specPath: 'apps/web/e2e/99-dry-run.spec.ts', processesStopped: true, flows: flows.map((f) => ({ flow: f, viewport: 'desktop', status: 'passed', screenshot: 'test-results/dry.png', assertions: [{ text: 'visible', passed: true }], consoleErrors: [], networkFailures: [], a11y: [], notes: '' })) }
    }
    if (label === 'ui-judge' || label === 'ui-rejudge') return { findings: [] }
    if (label === 'final-pass:package') return { digestPath: '/tmp/final-pass-digest-dry.md', files: 2, hunks: 3, note: '' }
    if (label === 'final-pass:read' || label === 'final-pass:read:2') return { findings: s.finalCandidates ? s.finalCandidates(label) : [] }
    if (label.startsWith('final-pass:decide')) {
      if (s.finalDecision) return s.finalDecision(label, prompt)
      // Count candidates ONLY in the "Candidates from the reader:" section — the
      // brief also lists known findings, which carry no [#index] marker, but stay safe.
      const marker = 'Candidates from the reader:'
      const at = prompt.indexOf(marker)
      const section = at === -1 ? '' : prompt.slice(at + marker.length)
      const n = (section.match(/\[#\d+\]/g) || []).length
      return { verdicts: Array.from({ length: n }, (_, i) => ({ index: i, real: true, severity: 'major', reason: 'dry' })), gaps: [], note: 'dry' }
    }
    // FIX PLANNING. The brief is mechanical: one item per [#i] in the prompt.
    if (label.startsWith('fix-brief:')) {
      const n = (prompt.match(/\[#\d+\]/g) || []).length
      return { items: Array.from({ length: n }, (_, i) => ({ index: i, file: 'x', line: 1, excerpt: 'code', callers: [], note: '' })) }
    }
    // The planner: a scenario's own `fixPlan` wins; the default fixes everything and
    // routes by risk exactly as the engine's rules say (HIGH-risk src/a.ts -> opus).
    if (label.startsWith('fix-plan:')) {
      if (s.fixPlan) return s.fixPlan(label, prompt)
      const decisions = planSection(prompt).map((chunk, i) => ({
        index: i,
        action: 'fix',
        design: 'apply the hint',
        invariant: 'x',
        tests: 'T1',
        route: chunk.includes('src/a.ts') ? 'opus' : 'sonnet',
        reason: 'dry',
      }))
      return { decisions, waves: [decisions.map((d) => d.index)], note: 'dry' }
    }
    if (label.startsWith('mutation-checksum')) return { files: s.mutFiles.map((f) => ({ file: f, checksum: HEX })) }
    if (label.startsWith('mutate:')) return { file: label.slice(7), defect: 'flipped', caught: true, restored: true, evidence: 'assertion failed', backupPath: '/tmp/x' }
    if (label.startsWith('fix:')) {
      s.calls = s.calls || {}
      s.calls[label] = (s.calls[label] || 0) + 1
      const custom = s.fixResponder && s.fixResponder(label, s.calls[label])
      return custom || { fixed: ['x'], skipped: [], filesChanged: ['src/a.ts'] }
    }
    if (label.startsWith('recheck')) return { findings: [] }
    // ---- bugfix mode (args.mode === 'bugfix'); never reached in feature mode ----
    if (label === 'radius-pack') return s.radiusPack === undefined ? { pack: PACK_TEXT, truncated: false, files: ['src/a.ts'] } : s.radiusPack
    if (label === 'harness-check') return { issues: s.harnessIssues || [] }
    if (label === 'sibling-grep') return { hits: s.siblingHits || [], truncated: s.siblingTruncated || [] }
    if (label === 'sibling-judge') {
      if (s.siblingVerdicts) return s.siblingVerdicts(label, prompt)
      // One verdict per [#i] hit; "defect" by default, so the finding reaches a fixer.
      const n = (prompt.slice(prompt.indexOf('Hits:')).match(/\[#\d+\]/g) || []).length
      return { verdicts: Array.from({ length: n }, (_, i) => ({ index: i, verdict: 'defect', severity: 'major', evidence: 'the same unguarded call, with no scope filter' })) }
    }
    return null
  }
}

async function run(s, srcText = src) {
  const calls = []
  const logs = []
  let spent = 0
  const respond = responder(s)
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, model: opts.model, effort: opts.effort, phase: opts.phase, prompt, prefixFirst: prompt.startsWith('You are working in the current directory') || prompt.startsWith('ALL work happens'), upheldNote: prompt.includes('disputing them again is not allowed'), fableDesign: prompt.includes("FABLE'S DESIGN") })
    spent += 1000
    const r = respond(opts.label, opts, prompt)
    return r === undefined ? null : r
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (t) => { try { return await t() } catch (e) { logs.push(`THROW ${e && e.message}`); return null } }))
  const pipelineFn = async (items, ...stages) => Promise.all(items.map(async (it, i) => { let v = it; for (const st of stages) v = await st(v, it, i); return v }))
  const log = (m) => logs.push(String(m))
  const phase = () => {}
  const budget = { total: null, spent: () => spent, remaining: () => Infinity }
  const fn = new Function('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', 'workflow', `return (async () => { ${srcText} })()`)
  const result = await fn(agent, parallel, pipelineFn, log, phase, s.args, budget, async () => null)
  return { result, calls, logs }
}
// E5 (owner ruling 2026-09-11, wave 3): CFG.cascadeReview is a static engine
// default (off), not an args knob, so exercising the cascade branch of
// reviewStage() needs a source variant with it flipped on. One targeted string
// replace, asserted unique so a future edit to that line fails loudly here
// instead of silently testing the wrong branch.
const CASCADE_MARKER = 'cascadeReview: false,'
if (src.split(CASCADE_MARKER).length - 1 !== 1) throw new Error(`E5 harness: expected exactly one "${CASCADE_MARKER}" in pipeline.js, found ${src.split(CASCADE_MARKER).length - 1}`)
const cascadeSrc = src.replace(CASCADE_MARKER, 'cascadeReview: true,')
const runCascade = (s) => run(s, cascadeSrc)

const cmds = ['npx tsc -p .', 'npx jest src']
// C1: every scenario now carries a runDir by default, so every existing scenario
// also exercises the checkpoint path (harmlessly — none of them assert exact
// call counts that a Haiku 'checkpoint:' call would perturb). A scenario that
// needs the LEGACY no-checkpoint path overrides runDir back to '' explicitly
// (see P2 below).
const CK_RUN_DIR = '/tmp/dry-run-checkpoints'
const baseArgs = (scale, extra = {}) => ({
  planPath: 'plan.md', specPath: 'spec.md', testPlanPath: 'test-plan.md', lessonsPath: 'LESSONS.md', startedAt: '2026-09-02T10:00:00Z',
  scale,
  runDir: CK_RUN_DIR,
  testPackages: [{ id: 'TP1', title: 't', files: ['src/a.spec.ts'], brief: 'b' }],
  redGate: { commands: ['jest a'], expect: 'fail' },
  packages: [{ id: 'WP1', title: 'w', files: ['src/a.ts'], brief: 'b' }],
  verifyCommands: { perRound: [cmds[0]], final: cmds },
  uiVerify: { flows: ['f'] },
  mutationProbe: { targets: [{ file: 'src/a.ts', behavior: 'x', test: 'jest a' }, { file: 'src/low.ts', behavior: 'y', test: 'jest low' }] },
  ...extra,
})
const highManifest = [
  { path: 'src/a.ts', status: 'modified', risk: 'HIGH', changedLines: 40 },
  { path: 'src/low.ts', status: 'modified', risk: 'LOW', changedLines: 10 },
  { path: 'src/a.spec.ts', status: 'added', risk: 'LOW', changedLines: 30 },
]
const lowManifest = highManifest.map((f) => ({ ...f, risk: 'LOW' }))
// A LOW-risk finding observed by DRIVING the UI: its fix has to be re-observed
// rendered, so the engine executes it on the review model whatever the plan says.
const uiFinding = { file: 'src/ui.ts', line: 3, severity: 'major', summary: 'focus ring never renders', detail: 'd', fixComplexity: 'mechanical', source: 'ui-verify' }
const uiManifest = [...highManifest, { path: 'src/ui.ts', status: 'modified', risk: 'LOW', changedLines: 5 }]
const twoFindings = [
  { file: 'src/a.ts', line: 1, severity: 'blocker', summary: 'wrong scope', detail: 'd', fixComplexity: 'judgment' },
  { file: 'src/low.ts', line: 2, severity: 'major', summary: 'off by one', detail: 'd', fixComplexity: 'mechanical' },
]

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`)
  else { failures++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}
const byLabel = (calls, p) => calls.filter((c) => c.label.startsWith(p))
// A2 (owner ruling 2026-09-11): a finding that SURVIVED review/refutation now
// lands in confirmedFindings (execution/ruled) or plausibleFindings (neither,
// yet), never dropped — these older scenarios test survival itself, not A2's
// verification tier, so they check both arrays rather than only the first.
const survived = (r, pred) => [...(r.confirmedFindings || []), ...(r.plausibleFindings || [])].some(pred)
const FULL_IDS = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']

// F1: the final checkpoint prompt embeds its payload as one bare JSON line (no
// spacing, so it never wraps) between the "Write EXACTLY this JSON..." line
// and "Touch NOTHING else." — extract and parse it so a scenario can assert
// on its actual shape rather than just the prose around it.
function extractCheckpointPayload(prompt) {
  if (!prompt) return null
  for (const line of prompt.split('\n')) {
    const t = line.trim()
    if (t.startsWith('{') && t.endsWith('}')) {
      try { return JSON.parse(t) } catch (e) { /* not the payload line */ }
    }
  }
  return null
}

// ---------- bugfix-mode fixtures (O-series) ----------
const bugfixArgs = (extra = {}) => baseArgs('major', { mode: 'bugfix', ...extra })
const twoHighManifest = [
  ...highManifest,
  { path: 'src/high2.ts', status: 'modified', risk: 'HIGH', changedLines: 12 },
  { path: 'src/high3.ts', status: 'modified', risk: 'HIGH', changedLines: 9 },
]
const corroboratedFinding = { file: 'src/a.ts', line: 1, severity: 'blocker', summary: 'wrong scope', detail: 'd', fixComplexity: 'judgment' }
const soloHighFinding = { file: 'src/high2.ts', line: 2, severity: 'blocker', summary: 'unscoped bulk write', detail: 'd', fixComplexity: 'judgment' }
// Corroborated by the same two lenses, but the location check cannot find what it
// cites. Several lenses echoing one wrong line out of one hunk is exactly the case
// where corroboration is not evidence, so this one must still be pre-refuted.
const misCitedFinding = { file: 'src/high3.ts', line: 99, severity: 'blocker', summary: 'stale citation', detail: 'd', fixComplexity: 'judgment' }
// TWO of the six lenses report the same findings independently; only one reports the
// solo one. All three files are HIGH risk, so risk alone cannot explain the difference.
const corroborationOverrides = {
  'review:': (label) => ({
    findings: label.startsWith('review:correctness')
      ? [corroboratedFinding, soloHighFinding, misCitedFinding]
      : label.startsWith('review:operability')
        ? [corroboratedFinding, misCitedFinding]
        : [],
  }),
}
// The labels that must NEVER appear in a feature-mode run.
const NEW_LABELS = ['radius-pack', 'harness-check', 'sibling-grep', 'sibling-judge']
// The two mutually exclusive halves of the radius-pack rule: containment for the lenses
// that read the change, the beyond-the-diff mandate for the one that hunts what the plan
// forgot. No lens prompt may ever carry both.
const CONTAINMENT = 'Open other files only to confirm a specific suspicion'
const BEYOND = 'your mandate is what lies BEYOND it'
// The house rules every scenario re-checks. The two DECIDERS (the fix planner and the
// final-pass decider) read nothing and carry no run prefix by design; everything else
// that acts in the repo — the new bugfix agents included — does.
function houseRules(calls) {
  check('every agent call carries a full model id', calls.every((c) => FULL_IDS.includes(c.model)), JSON.stringify([...new Set(calls.map((c) => c.model))]))
  check('every agent call carries an explicit effort', calls.every((c) => typeof c.effort === 'string' && c.effort), JSON.stringify(calls.filter((c) => !c.effort).map((c) => c.label)))
  const owed = calls.filter((c) => c.model !== 'claude-haiku-4-5' && !c.label.startsWith('final-pass:decide') && !c.label.startsWith('fix-plan:'))
  check('every repo-acting non-Haiku agent opens with the shared run prefix', owed.every((c) => c.prefixFirst), JSON.stringify(owed.filter((c) => !c.prefixFirst).map((c) => c.label)))
}
// C2 attribution: askAgent tags EVERY prompt (checkpoint prompts included — they
// go through askAgent too) with "PHASE: ... · LABEL: ...", inserted immediately
// AFTER the shared RUN_PREFIX() block when a prompt opens with it, so the house
// rule above (prefixFirst) is untouched: the prefix text itself never moves.
const TAG_RE = /PHASE: .+ · LABEL: .+/
function tagRules(calls) {
  check('every prompt carries a PHASE/LABEL tag', calls.every((c) => TAG_RE.test(c.prompt)), JSON.stringify(calls.filter((c) => !TAG_RE.test(c.prompt)).map((c) => c.label)))
  const owed = calls.filter((c) => c.model !== 'claude-haiku-4-5' && !c.label.startsWith('final-pass:decide') && !c.label.startsWith('fix-plan:'))
  const prefixed = owed.filter((c) => c.prefixFirst)
  check('for prefixed non-Haiku repo-acting agents, RUN_PREFIX precedes the tag (never the reverse)', prefixed.every((c) => c.prompt.indexOf('PHASE: ') > 0), JSON.stringify(prefixed.filter((c) => c.prompt.indexOf('PHASE: ') <= 0).map((c) => c.label)))
}
// F4: the mechanical Haiku "gate runner" prompts (baseline-gate, red-run, gate,
// regate:*, final-gate, mutation-checksum:*) open with REPO_NOTE directly, not
// the full RUN_PREFIX() — so askAgent must insert the tag right after THAT
// block too, not before it, or two such prompts on the same model+effort would
// no longer share a real byte prefix for the cache. Verified two ways without
// hardcoding REPO_NOTE's text: every qualifying call's tag lands at the same
// offset, and the bytes up to that offset are identical across every call
// (a stronger, exact form of "common prefix >= REPO_NOTE.length").
const HAIKU_GATE_LABELS = ['baseline-gate', 'red-run', 'gate', 'regate', 'final-gate', 'mutation-checksum']
function repoNoteTagRules(calls) {
  const qualifying = calls.filter(
    (c) => c.model === 'claude-haiku-4-5' && HAIKU_GATE_LABELS.some((p) => c.label === p || c.label.startsWith(p + ':'))
  )
  if (qualifying.length < 2) { check('at least two Haiku gate-runner prompts exist to compare (F4)', false, 'none matched — scenario setup is wrong'); return }
  const offsets = qualifying.map((c) => c.prompt.indexOf('PHASE: '))
  check(
    'every Haiku gate-runner prompt inserts the PHASE/LABEL tag at the same offset (right after the shared REPO_NOTE block)',
    offsets.every((o) => o > 0) && offsets.every((o) => o === offsets[0]),
    JSON.stringify(qualifying.map((c, i) => [c.label, offsets[i]]))
  )
  const prefix0 = qualifying[0].prompt.slice(0, offsets[0])
  check(
    'those prompts share a byte-identical prefix through REPO_NOTE (a common prefix >= REPO_NOTE.length)',
    qualifying.every((c) => c.prompt.slice(0, offsets[0]) === prefix0),
    JSON.stringify(qualifying.filter((c) => c.prompt.slice(0, offsets[0]) !== prefix0).map((c) => c.label))
  )
}
const probeOf = (r, file) => (r.mutationProbe.results || []).find((p) => p.file === file) || {}

// TOKEN-CLASS ROUTING CAPS (owner ruling 2026-09-10, CFG.caps). Every Opus-model
// prompt gets the tool-call cap clause EXCEPT the two no-tool Fable deciders
// (fix-plan / final-pass:decide) even on their Opus fallback — their prompt
// already says outright it reads no file and runs no command, so a tool-call
// cap would contradict that contract. Every Fable-model prompt's BRIEF (the
// prompt text minus the PHASE/LABEL tag askAgent prepends) stays at or under
// CFG.caps.fableBriefBytes (8192) — capFableBrief() truncates it in the script
// rather than trusting the packager to fit it on its own.
const OPUS_CAP_RE = /Hard cap: \d+ tool calls; if you need more, stop and report `needsMoreContext`/
function capRules(calls) {
  const opusOwed = calls.filter((c) => c.model === 'claude-opus-5' && !c.label.startsWith('final-pass:decide') && !c.label.startsWith('fix-plan:'))
  check(
    'every Opus-model prompt (excluding the no-tool Fable deciders) carries the tool-call cap clause',
    opusOwed.length > 0 && opusOwed.every((c) => OPUS_CAP_RE.test(c.prompt)),
    JSON.stringify(opusOwed.filter((c) => !OPUS_CAP_RE.test(c.prompt)).map((c) => c.label)),
  )
  const fableCalls = calls.filter((c) => c.model === 'claude-fable-5-1')
  const overCap = fableCalls.filter((c) => Buffer.byteLength(c.prompt.replace(/^PHASE: .+ · LABEL: .+\n/, ''), 'utf8') > 8192)
  check('no Fable-model prompt exceeds 8,192 bytes after the PHASE/LABEL tag', fableCalls.length > 0 && overCap.length === 0, JSON.stringify(overCap.map((c) => [c.label, Buffer.byteLength(c.prompt, 'utf8')])))
}

// A10 (owner ruling 2026-09-11): the checkpoint payload's idempotency key.
function checkpointIdempotencyKeys(calls) {
  return byLabel(calls, 'checkpoint:').map((c) => {
    const payload = extractCheckpointPayload(c.prompt)
    return { label: c.label, key: payload && payload.idempotencyKey }
  })
}

const scenarios = [
  {
    name: 'A. major, HIGH-risk files, Fable final-pass decider declines -> Opus fallback decides; lazy slate keeps on first vote; structural red bar',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false,
    // A3 (owner ruling 2026-09-11): corroboration-skip is now general, not
    // bugfix-only, so a finding every lens echoes (the harness's plain
    // `reviewFindings` default) would corroborate itself out of the very
    // per-file refuter batch this scenario exists to exercise. Report each
    // finding from exactly ONE lens, as a real run would.
    overrides: { 'review:': (label) => ({ findings: label.startsWith('review:correctness') ? twoFindings : [] }) },
    finalDecision: (label) => (label === 'final-pass:decide' ? null : { verdicts: [], gaps: [], note: 'fallback decided' }),
    assert({ result: r, calls }) {
      check('UI verify is a Sonnet driver at medium followed by an Opus judge at high', byLabel(calls, 'ui-drive').length === 1 && byLabel(calls, 'ui-drive')[0].model === 'claude-sonnet-5' && byLabel(calls, 'ui-drive')[0].effort === 'medium' && byLabel(calls, 'ui-judge').length === 1 && byLabel(calls, 'ui-judge')[0].model === 'claude-opus-5' && byLabel(calls, 'ui-judge')[0].effort === 'high' && r.uiVerify.completed === true && r.uiVerify.evidence && r.uiVerify.evidence.flows.length === 1)
      check('final pass is preceded by a Sonnet packager at low and the reader is told to use the digest', byLabel(calls, 'final-pass:package').length === 1 && byLabel(calls, 'final-pass:package')[0].model === 'claude-sonnet-5' && byLabel(calls, 'final-pass:package')[0].effort === 'low')
      check('every agent call carries a full model id', calls.every((c) => FULL_IDS.includes(c.model)), JSON.stringify([...new Set(calls.map((c) => c.model))]))
      check('every agent call carries an explicit effort', calls.every((c) => typeof c.effort === 'string' && c.effort), JSON.stringify(calls.filter((c) => !c.effort).map((c) => c.label)))
      check('deep lens runs at xhigh with HIGH-risk files', byLabel(calls, 'review:correctness').every((c) => c.effort === 'xhigh'))
      // A8 (owner ruling 2026-09-11; CORRECTED 2026-09-11c, C1): uniformLensEffort
      // shares the deepest effort PER MODEL FAMILY, not across the whole wave — a
      // Sonnet-only pattern lens never carries a DEEP lens (see unitModel), so it
      // always resolves to CFG.effort.lensPattern (high) regardless of what the
      // Opus family's correctness lens needs on a HIGH-risk file (xhigh). See A8b
      // below for the explicit per-model-family assertion this run also proves.
      check('pattern lens stays on Sonnet, at its own family\'s effort (high) — never raised by the Opus family\'s xhigh', byLabel(calls, 'review:test-quality').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'high'))
      check('A8: a warmer call preceded this wave for each distinct model used (Sonnet + Opus)', byLabel(calls, 'warm:claude-sonnet-5').length >= 1 && byLabel(calls, 'warm:claude-opus-5').length >= 1)
      check('deep lens stays on Opus', byLabel(calls, 'review:correctness').every((c) => c.model === 'claude-opus-5'))
      check('mutation probe runs on Sonnet at medium (token-class routing)', byLabel(calls, 'mutate:').length > 0 && byLabel(calls, 'mutate:').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'medium'))
      // A9 (owner ruling 2026-09-11, CFG.cheapFirst): Author-tests packages now run
      // at the CHEAP tier (low) first; this fixture's canned response is always
      // "done" on the first try, so no rerun is spent and testAuthoring.rerunCount
      // stays 0. Implement is untouched by A9 and stays at medium.
      check('tests run at the cheap tier (low) on Sonnet since every package came back done first try; impl stays at medium', byLabel(calls, 'tests:').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'low') && byLabel(calls, 'impl:').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'medium'))
      check('A9: no rerun was spent — nothing came back not-done', r.testAuthoring.rerunCount === 0 && calls.filter((c) => c.label.endsWith(':rerun')).length === 0)
      check('red gate: structural bar, one attempt, behavioral shortfall recorded', r.redGate.remediateOn === 'structural' && r.redGate.attempts === 1 && r.redGate.structurallyRed === true && r.redGate.behaviorallyRed === false)
      check('no red-gate blocker carried (structural bar met)', !r.remainingFindings.some((f) => f.file === '(red-gate)') && !r.confirmedFindings.some((f) => f.file === '(red-gate)'))
      check('mutation probe covers EVERY target after the behavioral shortfall', r.mutationProbe.probed === 2 && r.mutationProbe.skippedTargets.length === 0)
      check('location check ran once on Sonnet at low', byLabel(calls, 'location-check').length === 1 && byLabel(calls, 'location-check')[0].model === 'claude-sonnet-5' && byLabel(calls, 'location-check')[0].effort === 'low')
      check('verify on dispute: only the HIGH-risk finding is pre-refuted, the LOW one is deferred to the fixer', r.verify.preRefuted === 1 && r.verify.deferredToFixer === 1 && byLabel(calls, 'refute-batch:src/low.ts').length === 0)
      check('per-file batch: one refuter for src/a.ts at high; lazy slate casts no second vote on a keep', byLabel(calls, 'refute-batch:src/a.ts').length === 1 && byLabel(calls, 'refute-batch:src/a.ts')[0].effort === 'high' && byLabel(calls, 'refute2').length === 0 && r.verify.votesCast === 1)
      check('deferred LOW-risk finding reached a fixer (Fable-designed, LOW-risk -> Sonnet at medium)', byLabel(calls, 'fix:src/low.ts').length === 1 && byLabel(calls, 'fix:src/low.ts')[0].model === 'claude-sonnet-5' && byLabel(calls, 'fix:src/low.ts')[0].effort === 'medium')
      check('Verify ran beside UI verify (one bracket)', r.overlap.verifyWithUiVerify === true && r.phaseReport.find((p) => p.phase === 'UI verify').overlappedWith === 'Verify')
      check('final gate ran beside the final pass', r.overlap.finalGateWithFinalPass === true)
      check('final-pass:read ran once on Opus at xhigh', byLabel(calls, 'final-pass:read').length === 1 && byLabel(calls, 'final-pass:read')[0].model === 'claude-opus-5' && byLabel(calls, 'final-pass:read')[0].effort === 'xhigh')
      check('final-pass:decide ran on Fable at high, and final-pass:decide:fallback ran on Opus at xhigh after it declined', calls.some((c) => c.label === 'final-pass:decide' && c.model === 'claude-fable-5-1' && c.effort === 'high') && calls.some((c) => c.label === 'final-pass:decide:fallback' && c.model === 'claude-opus-5' && c.effort === 'xhigh'))
      check('final pass fell back to Opus, reader was Opus, and the pass completed', r.finalPass.fallback === true && r.finalPass.model === 'claude-opus-5' && r.finalPass.reader === 'claude-opus-5' && r.finalPass.completed === true)
      check('phaseReport rows carry estUsd and effort; estimatedCostUsd > 0', r.phaseReport.every((p) => 'estUsd' in p && 'effort' in p) && r.estimatedCostUsd > 0 && r.pricesAsOf)
      check('startedAt echoed', r.startedAt === '2026-09-02T10:00:00Z')
      // The DECIDERS — the final-pass decider and the fix planner (like the tie-break
      // judge) — rule from a compact brief only; their prompts say outright "you do
      // not read the repository, run commands or gather anything", so they carry no
      // RUN_PREFIX() by design. The fix BRIEF builder and every fix EXECUTOR do act
      // in the repo, and are held to the prefix rule like everything else.
      check('prompts open with the shared run prefix (non-Haiku agents that read the repo)', calls.filter((c) => c.model !== 'claude-haiku-4-5' && !c.label.startsWith('final-pass:decide') && !c.label.startsWith('fix-plan:')).every((c) => c.prefixFirst), JSON.stringify(calls.filter((c) => c.model !== 'claude-haiku-4-5' && !c.label.startsWith('final-pass:decide') && !c.label.startsWith('fix-plan:') && !c.prefixFirst).map((c) => c.label)))
      capRules(calls)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'B2. major, no HIGH-risk file, with findings -> UI judge and every refuter run on Sonnet at high (token-class routing)',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false,
    // Neither finding is on a HIGH-risk file, so under CFG.verify.mode 'on-dispute'
    // nothing would pre-refute on risk alone — mark both mis-cited instead, which
    // pre-refutes regardless of risk and actually exercises the refuter slate here.
    invalidIndexes: [0, 1],
    assert({ result: r, calls }) {
      check('UI judge runs on Sonnet at high without a HIGH-risk file', byLabel(calls, 'ui-judge').length === 1 && byLabel(calls, 'ui-judge')[0].model === 'claude-sonnet-5' && byLabel(calls, 'ui-judge')[0].effort === 'high')
      check('both mis-cited findings were pre-refuted', r.verify.preRefuted === 2 && r.verify.deferredToFixer === 0)
      check('every refuter (batch, per file) runs on Sonnet at high without a HIGH-risk file', byLabel(calls, 'refute-batch:').length === 2 && byLabel(calls, 'refute-batch:').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'high'))
      check('pattern lens on Sonnet, deep lens on Opus, whether or not a HIGH-risk file exists', byLabel(calls, 'review:test-quality').every((c) => c.model === 'claude-sonnet-5') && byLabel(calls, 'review:correctness').every((c) => c.model === 'claude-opus-5' && c.effort === 'high'))
      capRules(calls)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'A2. execution-verified CONFIRMED (owner ruling 2026-09-11): a finding with a corroborated red/green test is execution-verified and counted; the sibling finding with no verifying test stays plausible and is NOT counted',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false,
    // The fixer for src/low.ts proves its fix with a named red/green test; the
    // fixer for src/a.ts fixes its finding but reports no verifying test at all
    // — exactly the "no runnable check demonstrated" case A2 leaves plausible.
    fixResponder: (label) =>
      label === 'fix:src/low.ts'
        ? { fixed: ['off by one'], skipped: [], filesChanged: ['src/low.ts'], verifiedFixes: [{ summary: 'off by one', test: 'jest src/low.spec.ts', redOn: 'red: total off by one before the fix', greenOn: 'green: total correct after the fix' }] }
        : { fixed: ['wrong scope'], skipped: [], filesChanged: ['src/a.ts'] },
    assert({ result: r }) {
      const low = r.confirmedFindings.find((f) => f.file === 'src/low.ts')
      check('the corroborated finding is execution-verified and counted in confirmedFindings', !!low && low.verification === 'execution')
      check('its verifiedBy records the test and the red/green evidence', !!low && !!low.verifiedBy && low.verifiedBy.test === 'jest src/low.spec.ts' && !!low.verifiedBy.redOn && !!low.verifiedBy.greenOn)
      check('the unverified finding stays plausible, in plausibleFindings, and NOT in confirmedFindings', r.plausibleFindings.some((f) => f.file === 'src/a.ts' && f.verification === 'plausible') && !r.confirmedFindings.some((f) => f.file === 'src/a.ts'))
      check('confirmedByPhase counts only the execution-verified survivor', Object.values(r.confirmedByPhase).reduce((a, b) => a + b, 0) === 1)
    },
  },
  {
    name: 'E3. synthetic-key allowlist (owner ruling 2026-09-11, wave 3): a lens-supplied file like "(architecture)" is NOT one of the engine\'s own synthetic keys -> it is a normal finding, kept verbatim, routed as a real path, and stays plausible (not auto-confirmed as execution-verified the way a real "(mutation)"/"(gate)" finding is)',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [{ file: '(architecture)', line: 0, severity: 'major', summary: 'layering violation — UI imports the DB layer directly', detail: 'd', fixComplexity: 'judgment' }],
    firstRefuted: false,
    assert({ result: r }) {
      const all = [...r.confirmedFindings, ...r.plausibleFindings]
      check('the finding survives with its file kept verbatim', all.some((f) => f.file === '(architecture)'))
      check('it stays plausible (no execution evidence backs it) -- NOT auto-confirmed just because it starts with "("', r.plausibleFindings.some((f) => f.file === '(architecture)' && f.verification === 'plausible'))
      check('it is NOT in confirmedFindings', !r.confirmedFindings.some((f) => f.file === '(architecture)'))
    },
  },
  {
    name: 'A5. mutant feedback with acceptance bar (owner ruling 2026-09-11): a surviving mutant gets ONE Sonnet remediation; kept only when the re-probe catches it AND the gate stays green, otherwise reverted',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    overrides: {
      // src/a.ts: the probe's test misses the mutation; remediation strengthens
      // it; the re-probe of the SAME mutation now catches it; the gate holds -> KEPT.
      'mutate:src/a.ts': { file: 'src/a.ts', defect: 'flipped comparison', caught: false, restored: true, evidence: 'test passed on broken code', backupPath: '/tmp/mutprobe-a' },
      'mutation-remediate:src/a.ts': { filesChanged: ['src/a.spec.ts'], backupPath: '/tmp/mutremediate-a', note: 'strengthened the boundary assertion' },
      'mutate-reprobe:src/a.ts': { file: 'src/a.ts', defect: 'flipped comparison', caught: true, restored: true, evidence: 'now fails on the same mutation', backupPath: '/tmp/mutprobe-a2' },
      'gate:mutation-remediate:src/a.ts': green(cmds),
      // src/low.ts: same surviving mutant, but the re-probe STILL misses it after
      // remediation -> the acceptance bar is not met and the change is reverted.
      'mutate:src/low.ts': { file: 'src/low.ts', defect: 'off-by-one', caught: false, restored: true, evidence: 'test passed on broken code', backupPath: '/tmp/mutprobe-low' },
      'mutation-remediate:src/low.ts': { filesChanged: ['src/low.spec.ts'], backupPath: '/tmp/mutremediate-low', note: 'attempted a stronger assertion' },
      'mutate-reprobe:src/low.ts': { file: 'src/low.ts', defect: 'off-by-one', caught: false, restored: true, evidence: 'still passes on the mutation', backupPath: '/tmp/mutprobe-low2' },
      'mutation-remediate-revert:src/low.ts': { restored: true, note: 'reverted from backup' },
      // E2 happy path: the revert agent self-reports restored:true, and the
      // SEPARATE independent checksum agent confirms the reverted file matches
      // its backup byte-for-byte (same digest for both).
      'mutation-remediate-revert-checksum:src/low.ts': { files: [{ file: 'src/low.spec.ts', checksum: HEX }, { file: '/tmp/mutremediate-low', checksum: HEX }] },
    },
    assert({ result: r, calls }) {
      check('one Sonnet remediation agent ran per surviving mutant, at medium', byLabel(calls, 'mutation-remediate:').length === 2 && byLabel(calls, 'mutation-remediate:').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'medium'))
      check('the SAME mutation was re-probed on the probe model/effort', byLabel(calls, 'mutate-reprobe:').length === 2 && byLabel(calls, 'mutate-reprobe:').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'medium'))
      const bySrc = (f) => r.mutationProbe.remediation.find((m) => m.file === f)
      check('src/a.ts: caught on re-probe + gate green -> KEPT, no revert agent', bySrc('src/a.ts').kept === true && bySrc('src/a.ts').caughtAfter === true && byLabel(calls, 'mutation-remediate-revert:src/a.ts').length === 0)
      check('the gate was independently re-checked before accepting src/a.ts', byLabel(calls, 'gate:mutation-remediate:src/a.ts').length === 1)
      check('src/low.ts: still not caught on re-probe -> REVERTED, revert agent ran from the backup', bySrc('src/low.ts').kept === false && bySrc('src/low.ts').caughtAfter === false && byLabel(calls, 'mutation-remediate-revert:src/low.ts').length === 1)
      check('the gate was never spent on src/low.ts (it never got past the re-probe)', byLabel(calls, 'gate:mutation-remediate:src/low.ts').length === 0)
      check('the original one-shot allCaught verdict is untouched by remediation (still false)', r.mutationProbe.allCaught === false)
      // E2 happy path (owner ruling 2026-09-11, wave 3): restored:true PLUS an
      // independent checksum match -> revertVerified true, no blocker raised.
      check('E2: src/low.ts revert is independently verified (restored:true + matching checksum)', bySrc('src/low.ts').reverted === true && bySrc('src/low.ts').revertVerified === true)
      check('E2: no (mutation-remediation) blocker for a verified revert', !r.confirmedFindings.some((f) => f.file === '(mutation-remediation)' && f.target === 'src/low.ts'))
    },
  },
  {
    name: 'E2a. A5 revert verification (owner ruling 2026-09-11, wave 3): the revert agent reports restored:false -> a (mutation-remediation) blocker is raised so the run cannot close clean',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    overrides: {
      'mutate:src/low.ts': { file: 'src/low.ts', defect: 'off-by-one', caught: false, restored: true, evidence: 'test passed on broken code', backupPath: '/tmp/mutprobe-low' },
      'mutation-remediate:src/low.ts': { filesChanged: ['src/low.spec.ts'], backupPath: '/tmp/mutremediate-low', note: 'attempted a stronger assertion' },
      'mutate-reprobe:src/low.ts': { file: 'src/low.ts', defect: 'off-by-one', caught: false, restored: true, evidence: 'still passes on the mutation', backupPath: '/tmp/mutprobe-low2' },
      'mutation-remediate-revert:src/low.ts': { restored: false, note: 'byte-compare disagreed' },
    },
    assert({ result: r, calls }) {
      const bySrc = (f) => r.mutationProbe.remediation.find((m) => m.file === f)
      check('kept is false (rejected remediation)', bySrc('src/low.ts').kept === false)
      check('reverted is false and revertVerified is false when the revert agent reports restored:false', bySrc('src/low.ts').reverted === false && bySrc('src/low.ts').revertVerified === false)
      check('no independent checksum agent was spent chasing a self-reported failure', byLabel(calls, 'mutation-remediate-revert-checksum:').length === 0)
      check('a (mutation-remediation) blocker is raised for src/low.ts', r.confirmedFindings.some((f) => f.file === '(mutation-remediation)' && f.severity === 'blocker' && f.target === 'src/low.ts' && /may remain in the tree/.test(f.summary)))
    },
  },
  {
    name: 'E2b. A5 revert verification (owner ruling 2026-09-11, wave 3): the mutation-remediate-revert agent dies (no response) -> a (mutation-remediation) blocker is raised, never a silent pass',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    overrides: {
      'mutate:src/low.ts': { file: 'src/low.ts', defect: 'off-by-one', caught: false, restored: true, evidence: 'test passed on broken code', backupPath: '/tmp/mutprobe-low' },
      'mutation-remediate:src/low.ts': { filesChanged: ['src/low.spec.ts'], backupPath: '/tmp/mutremediate-low', note: 'attempted a stronger assertion' },
      'mutate-reprobe:src/low.ts': { file: 'src/low.ts', defect: 'off-by-one', caught: false, restored: true, evidence: 'still passes on the mutation', backupPath: '/tmp/mutprobe-low2' },
      // 'mutation-remediate-revert:src/low.ts' deliberately NOT overridden -> the
      // harness's default responder returns null (agent died or was skipped).
    },
    assert({ result: r, calls }) {
      const bySrc = (f) => r.mutationProbe.remediation.find((m) => m.file === f)
      check('the revert agent ran (and died)', byLabel(calls, 'mutation-remediate-revert:src/low.ts').length === 1)
      check('reverted is false and revertVerified is false when the revert agent dies', bySrc('src/low.ts').reverted === false && bySrc('src/low.ts').revertVerified === false)
      check('a (mutation-remediation) blocker is raised for src/low.ts', r.confirmedFindings.some((f) => f.file === '(mutation-remediation)' && f.severity === 'blocker' && f.target === 'src/low.ts' && /may remain in the tree/.test(f.summary)))
    },
  },
  {
    name: 'A6. flaky quarantine at the gate (owner ruling 2026-09-11): a test failing 1 of 3 reruns is quarantined and never triggers build-fix, but a test failing all 3 stays a genuine blocker',
    args: baseArgs('major', { verifyCommands: [cmds[1]] }), commands: [cmds[1]], manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    // NOTE: the responder matches override keys by startsWith(), in insertion
    // order — the more specific 'gate-flaky-rerun:rN' keys MUST come before the
    // bare 'gate' key or they would never be reached.
    overrides: {
      // 3 reruns of the SAME command: "flaky test" fails only once (1/3);
      // "genuinely broken test" fails every time (3/3).
      'gate-flaky-rerun:r1': { pass: false, results: [{ command: cmds[1], pass: false, summary: '2 failed', executed: 10, failedTests: ['flaky test', 'genuinely broken test'] }] },
      'gate-flaky-rerun:r2': { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['genuinely broken test'] }] },
      'gate-flaky-rerun:r3': { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['genuinely broken test'] }] },
      // Initial gate: two named tests fail on the one command.
      gate: { pass: false, results: [{ command: cmds[1], pass: false, summary: '2 failed', executed: 10, failedTests: ['flaky test', 'genuinely broken test'] }] },
      // Build-fix cannot fix a genuine defect it wasn't asked to fix here — the
      // regate (and ITS OWN flaky reruns) keep confirming the same real failure,
      // so the run stays dirty. 'regate' matches both 'regate:after-build-fix'
      // and the 'regate-after-build-fix-flaky-rerun:rN' reruns it triggers.
      regate: { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['genuinely broken test'] }] },
    },
    assert({ result: r, calls }) {
      check('exactly 3 reruns were spent on the SAME command, on the gate model at gate effort', byLabel(calls, 'gate-flaky-rerun:').length === 3 && byLabel(calls, 'gate-flaky-rerun:').every((c) => c.model === 'claude-haiku-4-5' && c.effort === 'low'))
      check('the flaky test (1/3 failures) is quarantined with name/runs/failures', r.quarantined.some((q) => q.name === 'flaky test' && q.runs === 3 && q.failures === 1))
      check('the genuinely broken test (3/3 failures) is NOT quarantined', !r.quarantined.some((q) => q.name === 'genuinely broken test'))
      check('build-fix STILL ran — the genuinely broken test is a real blocker the quarantine never excuses', byLabel(calls, 'build-fix').length === 1)
      check('run is NOT clean (a genuine gate failure remains)', r.clean === false)
    },
  },
  {
    name: 'A6b. flaky quarantine: EVERY originally-failing test turns out flaky or non-reproducing -> the command is forced to pass, no build-fix agent spent, and a quarantined test never counts as green either (it is still listed, not silently dropped)',
    args: baseArgs('major', { verifyCommands: [cmds[1]] }), commands: [cmds[1]], manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    // Same ordering note as A6 above.
    overrides: {
      'gate-flaky-rerun:r1': { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['flaky test'] }] },
      'gate-flaky-rerun:r2': green([cmds[1]]),
      'gate-flaky-rerun:r3': green([cmds[1]]),
      gate: { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['flaky test'] }] },
    },
    assert({ result: r, calls }) {
      check('3 reruns spent, none confirming the failure on every run (1/3)', byLabel(calls, 'gate-flaky-rerun:').length === 3)
      check('the flaky test is quarantined, never silently dropped', r.quarantined.some((q) => q.name === 'flaky test' && q.failures === 1 && q.runs === 3))
      check('no build-fix agent ran — the gate is forced to pass once every originally-failing test is accounted for', byLabel(calls, 'build-fix').length === 0)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'E1a. flaky quarantine ABANDONED on a dead rerun (owner ruling 2026-09-11, wave 3): 2 of 3 reruns reproduce the failure but the 3rd returns null (no evidence) -> NOT quarantined, gate stays red, build-fix still runs',
    args: baseArgs('major', { verifyCommands: [cmds[1]] }), commands: [cmds[1]], manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    // Same ordering note as A6: the specific 'gate-flaky-rerun:rN' keys must be
    // listed so the bare 'gate'/'regate' keys (matched by startsWith) never
    // swallow them — r3 is given explicitly as null (a dead rerun), not omitted.
    overrides: {
      'gate-flaky-rerun:r1': { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['flaky test'] }] },
      'gate-flaky-rerun:r2': { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['flaky test'] }] },
      'gate-flaky-rerun:r3': null,
      gate: { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['flaky test'] }] },
      regate: { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['flaky test'] }] },
    },
    assert({ result: r, calls }) {
      check('exactly 3 reruns were attempted on the same command', byLabel(calls, 'gate-flaky-rerun:').length === 3)
      check('the command is recorded as quarantineAbandoned with reason "dead rerun"', r.quarantineAbandoned.some((q) => q.command === cmds[1] && q.reason === 'dead rerun'))
      check('the command is NOT quarantined — a dead rerun is not evidence of anything', !r.quarantined.some((q) => q.command === cmds[1]))
      check('build-fix STILL ran — the abandoned quarantine leaves the original red result standing', byLabel(calls, 'build-fix').length === 1)
      check('run is NOT clean', r.clean === false)
    },
  },
  {
    name: 'E1b. flaky quarantine ABANDONED when ALL reruns are dead (owner ruling 2026-09-11, wave 3): 3/3 reruns return no usable results[] -> NOT quarantined, gate stays red',
    args: baseArgs('major', { verifyCommands: [cmds[1]] }), commands: [cmds[1]], manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    overrides: {
      'gate-flaky-rerun:r1': null,
      'gate-flaky-rerun:r2': { pass: false, summaryError: 'agent threw' }, // malformed: no results[]
      'gate-flaky-rerun:r3': null,
      gate: { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['flaky test'] }] },
      regate: { pass: false, results: [{ command: cmds[1], pass: false, summary: '1 failed', executed: 10, failedTests: ['flaky test'] }] },
    },
    assert({ result: r, calls }) {
      check('all 3 reruns were attempted', byLabel(calls, 'gate-flaky-rerun:').length === 3)
      check('the command is recorded as quarantineAbandoned', r.quarantineAbandoned.some((q) => q.command === cmds[1] && q.reason === 'dead rerun'))
      check('the command is NOT quarantined', !r.quarantined.some((q) => q.command === cmds[1]))
      check('run is NOT clean', r.clean === false)
    },
  },
  {
    name: 'A8. cache warmup + uniform lens effort (owner ruling 2026-09-11): one warmer per distinct model precedes the lens wave, and every unit in that wave shares one (the deepest) effort',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r, calls }) {
      const reviewCalls = calls.filter((c) => c.label.startsWith('review:'))
      const warmCalls = calls.filter((c) => c.label.startsWith('warm:'))
      check('exactly one warmer per distinct model used in the wave (Sonnet pattern lenses + Opus deep lenses)', warmCalls.length === 2 && new Set(warmCalls.map((c) => c.model)).size === 2 && warmCalls.every((c) => c.effort === 'low'))
      check('every warmer precedes every review call for this wave (index order)', warmCalls.every((wc) => reviewCalls.every((rc) => calls.indexOf(wc) < calls.indexOf(rc))))
      check('no HIGH-risk file here, so the wave\'s shared (deepest) effort is high, not xhigh', reviewCalls.length > 0 && reviewCalls.every((c) => c.effort === 'high'))
      check('model routing is untouched by uniform effort: deep lens still Opus, pattern lens still Sonnet', byLabel(calls, 'review:correctness').every((c) => c.model === 'claude-opus-5') && byLabel(calls, 'review:test-quality').every((c) => c.model === 'claude-sonnet-5'))
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'A8b. uniform lens effort is PER MODEL FAMILY, not per wave (owner ruling 2026-09-11c, C1): HIGH-risk major run — every Sonnet lens call stays at high (lensPattern), every Opus lens call escalates to xhigh (lensDeepHighRisk), and one warmer per model family still precedes the wave',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r, calls }) {
      const reviewCalls = calls.filter((c) => c.label.startsWith('review:'))
      const warmCalls = calls.filter((c) => c.label.startsWith('warm:'))
      const sonnetReview = reviewCalls.filter((c) => c.model === 'claude-sonnet-5')
      const opusReview = reviewCalls.filter((c) => c.model === 'claude-opus-5')
      check('every Sonnet lens call in this HIGH-risk wave stays at high — never escalated by the Opus family\'s xhigh', sonnetReview.length > 0 && sonnetReview.every((c) => c.effort === 'high'))
      check('every Opus lens call in this HIGH-risk wave escalates to xhigh (lensDeepHighRisk)', opusReview.length > 0 && opusReview.every((c) => c.effort === 'xhigh'))
      check('exactly one warmer per model family precedes the wave (Sonnet + Opus), each at low effort', warmCalls.length === 2 && new Set(warmCalls.map((c) => c.model)).size === 2 && warmCalls.every((c) => c.effort === 'low'))
      check('every warmer precedes every review call for this wave (index order)', warmCalls.every((wc) => reviewCalls.every((rc) => calls.indexOf(wc) < calls.indexOf(rc))))
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'E5. cascade warm-up + uniform effort (owner ruling 2026-09-11, wave 3): flipping CFG.cascadeReview on must not reintroduce a cold, mixed-effort fan-out -- the SAME A8 warm-up and per-model-family uniform effort from the non-cascade path also cover the cascade\'s low- and high-risk partitions',
    runner: runCascade,
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r, calls }) {
      const reviewCalls = calls.filter((c) => c.label.startsWith('review:'))
      const warmCalls = calls.filter((c) => c.label.startsWith('warm:'))
      check('the cascade path actually ran (both a low-risk and a high-risk partition pass)', reviewCalls.some((c) => c.label.endsWith('-low')) && reviewCalls.some((c) => c.label.endsWith('-high')))
      check('warmers precede EVERY cascade review call, both partitions', warmCalls.length > 0 && reviewCalls.every((rc) => warmCalls.some((wc) => calls.indexOf(wc) < calls.indexOf(rc))))
      check('a warmer covers the cheap cascade model (Sonnet) at low effort', warmCalls.some((c) => c.model === 'claude-sonnet-5' && c.effort === 'low'))
      const sonnetReview = reviewCalls.filter((c) => c.model === 'claude-sonnet-5')
      const opusReview = reviewCalls.filter((c) => c.model === 'claude-opus-5')
      check('every Sonnet lens call across BOTH cascade partitions shares one uniform effort (high) -- never a cold per-unit mix', sonnetReview.length > 0 && sonnetReview.every((c) => c.effort === 'high'), JSON.stringify(sonnetReview.map((c) => [c.label, c.effort])))
      check('every Opus lens call in the HIGH-risk partition escalates to the same uniform xhigh', opusReview.length > 0 && opusReview.every((c) => c.effort === 'xhigh'), JSON.stringify(opusReview.map((c) => [c.label, c.effort])))
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'A9. run cheap, rerun failures (owner ruling 2026-09-11): a test package that comes back not-done at the cheap tier is rerun once at the default effort, and rerunCount records it',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    overrides: {
      // The cheap-tier attempt comes back "partial"; the rerun (a distinct label)
      // comes back "done".
      'tests:TP1:rerun': done(['src/a.spec.ts']),
      'tests:TP1': { status: 'partial', filesChanged: [], deviations: 'ran out of context at the cheap tier', notes: '' },
    },
    assert({ result: r, calls }) {
      const first = byLabel(calls, 'tests:TP1').find((c) => c.label === 'tests:TP1')
      const rerun = byLabel(calls, 'tests:TP1').find((c) => c.label === 'tests:TP1:rerun')
      check('the first attempt ran at the cheap tier (low)', !!first && first.model === 'claude-sonnet-5' && first.effort === 'low')
      check('the rerun ran once, at the ordinary default effort (medium)', !!rerun && rerun.model === 'claude-sonnet-5' && rerun.effort === 'medium')
      check('rerunCount records exactly 1', r.testAuthoring.rerunCount === 1)
      check('the rerun\'s result (done) replaced the cheap attempt\'s (partial) — no lingering (tests) blocker', r.testAuthoring.packages.find((p) => p.package === 'TP1').status === 'done' && !r.remainingFindings.some((f) => f.file === '(tests)'))
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'E6. Fable brief cap marker names the ACTUAL byte cap (owner ruling 2026-09-11, wave 3): a fix-plan brief over CFG.caps.fableBriefBytes is truncated with a marker naming the real cap, not a stale hardcoded "8 KB"',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    // One oversized finding detail is enough to push fixPlanPrompt() past the
    // 8192-byte cap and force capFableBrief() to truncate it.
    reviewFindings: [{ file: 'src/a.ts', line: 1, severity: 'blocker', summary: 'wrong scope', detail: 'x'.repeat(9000), fixComplexity: 'judgment' }],
    firstRefuted: false,
    assert({ calls }) {
      const planCalls = byLabel(calls, 'fix-plan:')
      check('at least one fix-plan agent ran', planCalls.length > 0)
      check('the oversized brief carries the marker naming the actual byte cap (8192)', planCalls.some((c) => c.prompt.includes('[truncated at 8192 bytes — packager must tighten]')))
      check('the stale hardcoded "8 KB" marker text never appears anywhere', calls.every((c) => !c.prompt.includes('truncated at 8 KB')))
    },
  },
  {
    name: 'B. major, no HIGH-risk file -> final pass skipped and recorded; lenses at high',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r, calls }) {
      check('final pass skipped with reason', r.finalPass.ran === false && r.finalPass.skipped === 'no-high-risk-files' && byLabel(calls, 'final-pass').length === 0)
      check('deep lens runs at high without HIGH-risk files', byLabel(calls, 'review:correctness').every((c) => c.effort === 'high'))
      check('Verify not entered with zero findings; UI verify ran alone', r.verify.ran === false && r.uiVerify.ran === true && r.overlap.verifyWithUiVerify === false)
      check('final gate still ran (under Fix)', byLabel(calls, 'final-gate').length === 1 && r.overlap.finalGateWithFinalPass === false)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'C. small -> behavioral bar keeps remediation + blocker; merged lens; no Verify; final pass small-scale',
    args: baseArgs('small', { mutationProbe: undefined, uiVerify: undefined }), commands: cmds, manifest: lowManifest, mutFiles: [],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r, calls }) {
      check('small keeps the behavioral bar and spends the remediation round', r.redGate.remediateOn === 'behavioral' && r.redGate.attempts === 2 && byLabel(calls, 'red-remediate').length === 1)
      check('red-gate blocker carried when the bar is not met', r.confirmedFindings.some((f) => f.file === '(red-gate)'))
      check('one merged review agent', byLabel(calls, 'review:').length === 1 && byLabel(calls, 'review:small-combined').length === 1)
      check('no refuters, final pass marked small-scale', byLabel(calls, 'refute').length === 0 && r.finalPass.skipped === 'small-scale')
      check('run is NOT clean (red gate)', r.clean === false)
    },
  },
  {
    name: 'D. lazy slate: batch first vote refutes -> second vote; split -> Fable tie-break at high; LOW finding deferred',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: true,
    // A3: report each finding from exactly one lens — see scenario A's note.
    overrides: {
      'review:': (label) => ({ findings: label.startsWith('review:correctness') ? twoFindings : [] }),
      'refute2:src/a.ts': { refuted: false, reason: 'holds' },
      'tiebreak:': { refuted: false, reason: 'keep' },
    },
    assert({ result: r, calls }) {
      check('second vote cast only after the batch refuted the HIGH-risk finding', byLabel(calls, 'refute2').length === 1 && byLabel(calls, 'refute2:src/a.ts').length === 1 && r.verify.firstVoteRefuted === 1)
      check('split vote goes to the Fable tie-break at high and the finding is kept', byLabel(calls, 'tiebreak:src/a.ts').length === 1 && byLabel(calls, 'tiebreak:src/a.ts')[0].model === 'claude-fable-5-1' && byLabel(calls, 'tiebreak:src/a.ts')[0].effort === 'high' && survived(r, (f) => f.file === 'src/a.ts') && r.verify.dropped === 0)
      check('LOW finding was never pre-refuted and still reached the fix loop', r.verify.deferredToFixer === 1 && survived(r, (f) => f.file === 'src/low.ts'))
      check('judgment fixer on Opus at high for the HIGH-risk file', byLabel(calls, 'fix:src/a.ts').every((c) => c.model === 'claude-opus-5' && c.effort === 'high'))
    },
  },
  {
    name: 'F. refute-first fixer disputes a LOW-risk finding -> slate agrees -> dropped, never fixed',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false, disputeRefuted: true, secondRefuted: true,
    fixResponder: (label) => (label === 'fix:src/low.ts' ? { fixed: [], skipped: [], disputed: [{ summary: 'off by one', reason: 'the loop bound is exclusive by contract' }], filesChanged: [] } : null),
    assert({ result: r, calls }) {
      check('the dispute went to a per-file slate inside the Fix phase, on Sonnet at high (token-class routing: LOW-risk file)', byLabel(calls, 'refute-batch:src/low.ts').length === 1 && byLabel(calls, 'refute-batch:src/low.ts')[0].phase === 'Fix' && byLabel(calls, 'refute-batch:src/low.ts')[0].effort === 'high' && byLabel(calls, 'refute-batch:src/low.ts')[0].model === 'claude-sonnet-5')
      check('two agreeing refuters dropped it', r.verify.disputed === 1 && r.verify.disputesDropped === 1 && r.verify.disputesUpheld === 0 && byLabel(calls, 'refute2:src/low.ts').length === 1)
      check('the disputed finding is gone and was fixed by nobody', !r.remainingFindings.some((f) => f.file === 'src/low.ts') && byLabel(calls, 'fix:src/low.ts').length === 1)
      // C2 (owner ruling 2026-09-11c, "A7"): every one of the 6 major-scale lenses
      // echoed BOTH findings by default in this scenario (no per-lens override,
      // unlike A/D), so lensReport must show one row per lens, 2 raw findings
      // each (12 total, matching the 6-lens x 2-finding raw count before
      // dedupe), and the src/low.ts finding — dropped by judgeFindings in the
      // Fix-phase dispute above — must count as `overturned` on EVERY lens row,
      // since every lens raised it.
      const LENS_NAMES = ['correctness', 'spec-compliance', 'test-quality', 'edge-cases-and-security', 'operability', 'scope-coverage']
      check('lensReport has exactly one row per lens that ran', Array.isArray(r.lensReport) && r.lensReport.length === LENS_NAMES.length && LENS_NAMES.every((l) => r.lensReport.some((row) => row.lens === l)))
      check('lensReport rawFindings sum to the raw findings actually raised (6 lenses x 2 findings, before dedupe)', r.lensReport.reduce((n, row) => n + row.rawFindings, 0) === 12 && r.lensReport.every((row) => row.rawFindings === 2))
      check('the dropped src/low.ts finding shows as overturned on every lens row that raised it', r.lensReport.every((row) => row.overturned === 1))
      check('both findings were corroborated (every lens reported both)', r.lensReport.every((row) => row.corroborated === 2))
      check('lensReport model/effort match token-class routing: Opus lenses at xhigh (HIGH-risk file), Sonnet lenses at high', r.lensReport.filter((row) => ['correctness', 'spec-compliance', 'edge-cases-and-security', 'operability'].includes(row.lens)).every((row) => row.model === 'claude-opus-5' && row.effort === 'xhigh') && r.lensReport.filter((row) => ['test-quality', 'scope-coverage'].includes(row.lens)).every((row) => row.model === 'claude-sonnet-5' && row.effort === 'high'))
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'G. fixer disputes, slate splits, Fable upholds -> finding returns marked and is fixed in round 2',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false, disputeRefuted: true, secondRefuted: false, judgeRefuted: false,
    fixResponder: (label, n) => (label === 'fix:src/low.ts' && n === 1 ? { fixed: [], skipped: [], disputed: [{ summary: 'off by one', reason: 'looks intended' }], filesChanged: [] } : null),
    assert({ result: r, calls }) {
      check('split on the dispute went to the Fable judge, who upheld it', byLabel(calls, 'tiebreak:src/low.ts').length === 1 && r.verify.disputesUpheld === 1 && r.verify.disputesDropped === 0)
      check('the upheld finding came back and a second round fixed it, told not to dispute again', r.fixRounds === 2 && byLabel(calls, 'fix:src/low.ts').length === 2 && byLabel(calls, 'fix:src/low.ts')[1].upheldNote === true)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'G2. an executor disputes by [#index] with a paraphrased summary -> still matched to its finding and judged',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false, disputeRefuted: true, secondRefuted: true,
    // No summary the matcher could recognise: only `index` identifies the finding.
    fixResponder: (label) => (label === 'fix:src/low.ts'
      ? { fixed: [], skipped: [], disputed: [{ index: 0, summary: 'the boundary thing we discussed', reason: 'the loop bound is exclusive by contract' }], filesChanged: [] }
      : null),
    assert({ result: r, calls }) {
      check('the index-matched dispute reached the slate', r.verify.disputed === 1 && byLabel(calls, 'refute-batch:src/low.ts').some((c) => c.phase === 'Fix'))
      check('two agreeing refuters dropped it, and no fixer ever touched it', r.verify.disputesDropped === 1 && r.verify.disputesUpheld === 0 && !r.remainingFindings.some((f) => f.file === 'src/low.ts') && byLabel(calls, 'fix:src/low.ts').length === 1)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'M. mutation: the pre-probe baseline moved under the run -> the probes\' own digests clear the file, and it is NOT a restore failure',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    // The before-agent digested src/a.ts as HEX2; by the time the probe read it the
    // file held HEX3, and it still holds HEX3 now. The probe saw the same content
    // before and after its own mutation, so nothing this run did was left behind.
    overrides: {
      'mutation-checksum:before': { files: [{ file: 'src/a.ts', checksum: HEX2 }, { file: 'src/low.ts', checksum: HEX }] },
      'mutation-checksum:after': { files: [{ file: 'src/a.ts', checksum: HEX3 }, { file: 'src/low.ts', checksum: HEX }] },
      'mutate:src/a.ts': { file: 'src/a.ts', defect: 'flipped', caught: true, restored: true, evidence: 'assertion failed', backupPath: '/tmp/x', preHash: HEX3, postHash: HEX3 },
    },
    assert({ result: r, calls }) {
      check('no (mutation) finding was raised for the disturbed baseline', !r.confirmedFindings.some((f) => f.file === '(mutation)') && !r.remainingFindings.some((f) => f.file === '(mutation)'))
      check('the restore stays independently verified', r.mutationProbe.restoredVerified === true && r.mutationProbe.checksumMismatches.length === 0)
      check('the file is recorded under baselineDisturbed with an explaining note', r.mutationProbe.baselineDisturbed.length === 1 && r.mutationProbe.baselineDisturbed[0] === 'src/a.ts' && /BASELINE was taken on different content/.test(r.mutationProbe.note))
      check('no fixer was dispatched to reconstruct an intact file', byLabel(calls, 'fix:(mutation)').length === 0 && r.fixRounds === 0)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'N. mutation: the probe\'s own before/after digests DISAGREE -> today\'s restore-failure blocker, unchanged',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    overrides: {
      'mutation-checksum:before': { files: [{ file: 'src/a.ts', checksum: HEX2 }, { file: 'src/low.ts', checksum: HEX }] },
      'mutation-checksum:after': { files: [{ file: 'src/a.ts', checksum: HEX3 }, { file: 'src/low.ts', checksum: HEX }] },
      'mutate:src/a.ts': { file: 'src/a.ts', defect: 'flipped', caught: true, restored: true, evidence: 'assertion failed', backupPath: '/tmp/x', preHash: HEX2, postHash: HEX3 },
    },
    assert({ result: r, calls }) {
      check('the checksum mismatch is still a (mutation) blocker', r.confirmedFindings.some((f) => f.file === '(mutation)' && f.severity === 'blocker' && /NOT back to/.test(f.summary)))
      check('the restore is NOT verified and the file is a mismatch, not a disturbed baseline', r.mutationProbe.restoredVerified === false && r.mutationProbe.checksumMismatches.includes('src/a.ts') && r.mutationProbe.baselineDisturbed.length === 0)
      check('the blocker reached a fixer, and the synthetic-only round bought no plan', byLabel(calls, 'fix:(mutation)').length === 1 && byLabel(calls, 'fix-plan').length === 0)
      check('run is NOT clean', r.clean === false)
    },
  },
  {
    name: 'I. fix planning: Sonnet brief -> Fable plan -> executors implement the design (HIGH-risk and ui-verify upgraded to Opus, designed LOW-risk on Sonnet at medium)',
    args: baseArgs('major'), commands: cmds, manifest: uiManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [...twoFindings, uiFinding], firstRefuted: false,
    assert({ result: r, calls }) {
      check('fix-brief:r1 ran once on Sonnet at low, carrying the run prefix', byLabel(calls, 'fix-brief:r1').length === 1 && byLabel(calls, 'fix-brief:r1')[0].model === 'claude-sonnet-5' && byLabel(calls, 'fix-brief:r1')[0].effort === 'low' && byLabel(calls, 'fix-brief:r1')[0].prefixFirst === true)
      check('fix-plan:r1 ran once on Fable at high and is a decider (no run prefix, no fallback)', byLabel(calls, 'fix-plan:r1').length === 1 && byLabel(calls, 'fix-plan:r1')[0].model === 'claude-fable-5-1' && byLabel(calls, 'fix-plan:r1')[0].effort === 'high' && byLabel(calls, 'fix-plan:r1')[0].prefixFirst === false && byLabel(calls, 'fix-plan:r1:fallback').length === 0)
      check('HIGH-risk group is upgraded to Opus at high whatever the plan said', byLabel(calls, 'fix:src/a.ts').length === 1 && byLabel(calls, 'fix:src/a.ts')[0].model === 'claude-opus-5' && byLabel(calls, 'fix:src/a.ts')[0].effort === 'high')
      check('designed LOW-risk group runs on Sonnet at medium', byLabel(calls, 'fix:src/low.ts').length === 1 && byLabel(calls, 'fix:src/low.ts')[0].model === 'claude-sonnet-5' && byLabel(calls, 'fix:src/low.ts')[0].effort === 'medium')
      // The plan routes src/ui.ts "sonnet" (LOW risk); a ui-verify fix has to be
      // re-observed rendered, so the ENGINE overrides that to the review model.
      check('a LOW-risk ui-verify finding the plan routed sonnet is upgraded to Opus at high', byLabel(calls, 'fix:src/ui.ts').length === 1 && byLabel(calls, 'fix:src/ui.ts')[0].model === 'claude-opus-5' && byLabel(calls, 'fix:src/ui.ts')[0].effort === 'high' && r.fixPlanning.rounds[0].routes.sonnet === 2)
      check('every executor prompt carries FABLE\'S DESIGN', byLabel(calls, 'fix:').length === 3 && byLabel(calls, 'fix:').every((c) => c.fableDesign === true))
      check('the plan is recorded as completed, on Fable, with 3 fix decisions and no floor skip', r.fixPlanning.enabled === true && r.fixPlanning.rounds.length === 1 && r.fixPlanning.rounds[0].completed === true && r.fixPlanning.rounds[0].skipped === null && r.fixPlanning.rounds[0].model === 'claude-fable-5-1' && r.fixPlanning.rounds[0].fallback === false && r.fixPlanning.rounds[0].actions.fix === 3)
      check('fixRouting counts the designed Sonnet tier separately, and what ran differs from what was asked only at the upgrade', r.fixRouting.sonnetDesigned === 1 && r.fixRouting.judgment === 2 && r.fixRouting.mechanical === 0)
      check('the Fix phase note says the fixes were Fable-planned', /Fable-planned/.test(r.phaseReport.find((p) => p.phase === 'Fix').note))
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'J. fix planning: Fable declines -> Opus fallback planner declines too -> the round runs on legacy routing, recorded unplanned',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false,
    fixPlan: () => null,
    assert({ result: r, calls }) {
      check('fix-plan:r1 was retried once on Opus at xhigh', byLabel(calls, 'fix-plan:r1:fallback').length === 1 && byLabel(calls, 'fix-plan:r1:fallback')[0].model === 'claude-opus-5' && byLabel(calls, 'fix-plan:r1:fallback')[0].effort === 'xhigh')
      check('the round is recorded as unplanned', r.fixPlanning.enabled === true && r.fixPlanning.rounds[0].completed === false && r.fixPlanning.rounds[0].model === null && r.fixPlanning.rounds[0].fallback === true)
      check('legacy routing applied: mechanical LOW-risk finding -> Sonnet at low', byLabel(calls, 'fix:src/low.ts').length === 1 && byLabel(calls, 'fix:src/low.ts')[0].model === 'claude-sonnet-5' && byLabel(calls, 'fix:src/low.ts')[0].effort === 'low')
      check('legacy routing applied: HIGH-risk finding -> Opus at high', byLabel(calls, 'fix:src/a.ts')[0].model === 'claude-opus-5' && byLabel(calls, 'fix:src/a.ts')[0].effort === 'high')
      check('no executor prompt claims a design', byLabel(calls, 'fix:').every((c) => c.fableDesign === false) && r.fixRouting.sonnetDesigned === 0)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'K. fix planning: a deferred finding is never fixed and stays open; a planner-disputed one goes to the slate and is dropped only when it agrees',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false, disputeRefuted: true, secondRefuted: true,
    // src/a.ts (HIGH risk) -> dispute with proof; src/low.ts -> defer to the owner.
    fixPlan: (label, prompt) => ({
      decisions: planSection(prompt).map((chunk, i) => (chunk.includes('src/a.ts')
        ? { index: i, action: 'dispute', design: '', invariant: '', tests: '', route: 'opus', reason: 'the excerpt shows the caller applies the scope filter' }
        : { index: i, action: 'defer', design: '', invariant: '', tests: '', route: 'sonnet', reason: 'the loop bound is a product decision the owner must make' })),
      waves: [],
      note: 'dry: one dispute, one defer',
    }),
    assert({ result: r, calls }) {
      check('the plan is recorded with one dispute and one defer, and no fix', r.fixPlanning.rounds[0].completed === true && r.fixPlanning.rounds[0].actions.dispute === 1 && r.fixPlanning.rounds[0].actions.defer === 1 && r.fixPlanning.rounds[0].actions.fix === 0)
      check('neither finding reached an executor', byLabel(calls, 'fix:').length === 0)
      check('the deferred finding is still open, carrying the planner\'s reason', r.remainingFindings.some((f) => f.file === 'src/low.ts' && /product decision/.test(f.deferred || '')))
      check('the deferral is listed as an owner question under fixPlanning.deferred', r.fixPlanning.deferred.length === 1 && r.fixPlanning.deferred[0].file === 'src/low.ts' && r.fixPlanning.deferred[0].summary === 'off by one' && /product decision/.test(r.fixPlanning.deferred[0].reason))
      check('the planner\'s dispute went to a per-file slate inside the Fix phase', byLabel(calls, 'refute-batch:src/a.ts').some((c) => c.phase === 'Fix') && byLabel(calls, 'refute2:src/a.ts').length === 1 && r.verify.disputed === 1)
      check('two agreeing refuters dropped the disputed finding', r.verify.disputesDropped === 1 && r.verify.disputesUpheld === 0 && !r.remainingFindings.some((f) => f.file === 'src/a.ts'))
      check('a deferred finding is not re-planned in a later round', byLabel(calls, 'fix-plan:').length === 1 && r.fixRounds === 1)
      check('run is NOT clean while a finding is deferred', r.clean === false)
    },
  },
  {
    name: 'L. args.fixPlanning === false reproduces the pre-planner routing exactly',
    args: baseArgs('major', { fixPlanning: false }), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false,
    assert({ result: r, calls }) {
      check('no brief and no planner agent ran', byLabel(calls, 'fix-brief').length === 0 && byLabel(calls, 'fix-plan').length === 0)
      check('the result records the planner as disabled with no rounds', r.fixPlanning.enabled === false && r.fixPlanning.rounds.length === 0)
      check('mechanical LOW-risk finding -> Sonnet at low', byLabel(calls, 'fix:src/low.ts').length === 1 && byLabel(calls, 'fix:src/low.ts')[0].model === 'claude-sonnet-5' && byLabel(calls, 'fix:src/low.ts')[0].effort === 'low')
      check('judgment HIGH-risk finding -> Opus at high', byLabel(calls, 'fix:src/a.ts').length === 1 && byLabel(calls, 'fix:src/a.ts')[0].model === 'claude-opus-5' && byLabel(calls, 'fix:src/a.ts')[0].effort === 'high')
      check('no executor prompt claims a design; only the legacy counters move', byLabel(calls, 'fix:').every((c) => c.fableDesign === false) && r.fixRouting.sonnetDesigned === 0 && r.fixRouting.mechanical === 1 && r.fixRouting.judgment === 1)
      check('the Fix phase model/effort lines name only the legacy tiers', !/brief/.test(r.phaseReport.find((p) => p.phase === 'Fix').model) && !/plan/.test(r.phaseReport.find((p) => p.phase === 'Fix').effort))
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'E. hollow gate: green with 0 tests executed on a test command is a failure',
    args: baseArgs('major', { verifyCommands: [cmds[1]] }), commands: [cmds[1]], manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    overrides: { gate: green([cmds[1]], 0), 'regate': green([cmds[1]], 0) },
    assert({ result: r, calls }) {
      check('a green that executed nothing triggers the build-fix path', byLabel(calls, 'build-fix').length === 1)
      check('the hollow gate is a (gate) finding', r.confirmedFindings.some((f) => f.file === '(gate)' && /EXECUTED NOTHING/.test(f.detail)))
      check('planning floor: a round of synthetic keys only buys no brief and no planner', byLabel(calls, 'fix-brief').length === 0 && byLabel(calls, 'fix-plan').length === 0)
      check('the skipped round is recorded, not silently omitted', r.fixPlanning.enabled === true && r.fixPlanning.rounds[0].skipped === 'synthetic-only' && r.fixPlanning.rounds[0].completed === false)
      check('the (gate) fixer still ran on Opus at high under legacy routing', byLabel(calls, 'fix:(gate)').every((c) => c.model === 'claude-opus-5' && c.effort === 'high' && c.fableDesign === false))
      check('run is NOT clean', r.clean === false)
      // R1 CALIBRATION (owner ruling 2026-09-11): build-fix escalates to Opus
      // ONLY because this manifest carries a HIGH-risk file.
      check('R1: build-fix escalates to Opus with a HIGH-risk file in the manifest', byLabel(calls, 'build-fix').every((c) => c.model === 'claude-opus-5' && c.effort === 'high'))
    },
  },
  {
    name: 'R1. calibration routing (owner ruling 2026-09-11, ROUTING-PLAN.md §9b): test-remediation always Sonnet; recheck/build-fix Sonnet on a LOW-risk manifest, Opus escalation proven by E above; correctness lens never demoted (A4)',
    args: baseArgs('major', { verifyCommands: [cmds[1]] }), commands: [cmds[1]], manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false,
    overrides: { gate: green([cmds[1]], 0), 'regate': green([cmds[1]], 0) },
    async assert({ result: r, calls }) {
      check('R1: build-fix stays on Sonnet at high with NO HIGH-risk file in the manifest', byLabel(calls, 'build-fix').length === 1 && byLabel(calls, 'build-fix').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'high'))
      check('R1: recheck stays on Sonnet at high with NO HIGH-risk file in the manifest', byLabel(calls, 'recheck:').length > 0 && byLabel(calls, 'recheck:').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'high'))
      check('A4: the correctness lens never left Opus even though this manifest has no HIGH-risk file', byLabel(calls, 'review:correctness').length > 0 && byLabel(calls, 'review:correctness').every((c) => c.model === 'claude-opus-5'))
      check('A4: the pattern lens (test-quality) DID route to Sonnet on the same run', byLabel(calls, 'review:test-quality').every((c) => c.model === 'claude-sonnet-5'))
      // test-remediation is unconditional (no risk gate) — prove it on a SEPARATE
      // small-scale run whose lowManifest forces the behavioral-shortfall
      // remediation round (same fixture as scenario C above).
      const smallRun = await run({
        args: baseArgs('small', { mutationProbe: undefined, uiVerify: undefined }), commands: cmds, manifest: lowManifest, mutFiles: [],
        reviewFindings: [], firstRefuted: false,
      })
      check('R1: test-remediation runs on Sonnet at medium (unconditional — no risk gate)', byLabel(smallRun.calls, 'red-remediate').length === 1 && byLabel(smallRun.calls, 'red-remediate').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'medium'))
    },
  },
  {
    name: 'H. final pass: decider rejects one candidate and names a gap -> one focused re-read finds a real defect in the gap',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    finalCandidates: (label) => (label === 'final-pass:read'
      ? [
          { file: 'src/a.ts', line: 5, severity: 'major', summary: 'cross-file drift', detail: 'evidence', fixComplexity: 'judgment' },
          { file: 'src/a.ts', line: 9, severity: 'minor', summary: 'not real', detail: 'weak', fixComplexity: 'judgment' },
        ]
      : [{ file: 'src/low.ts', line: 1, severity: 'major', summary: 'found in the gap', detail: 'evidence 2', fixComplexity: 'judgment' }]),
    finalDecision: (label) => (label === 'final-pass:decide'
      ? {
          verdicts: [
            { index: 0, real: true, severity: 'blocker', reason: 'real' },
            { index: 1, real: false, severity: 'minor', reason: 'not real' },
          ],
          gaps: ['callers of foo in src/low.ts'],
          note: 'one real, one gap',
        }
      : { verdicts: [{ index: 0, real: true, severity: 'major', reason: 'real' }], gaps: [], note: 'second' }),
    assert({ result: r, calls }) {
      check('final-pass:read:2 (the focused re-read) ran once', byLabel(calls, 'final-pass:read:2').length === 1)
      check('final-pass:decide:2 ran once on Fable at high', byLabel(calls, 'final-pass:decide:2').length === 1 && byLabel(calls, 'final-pass:decide:2')[0].model === 'claude-fable-5-1' && byLabel(calls, 'final-pass:decide:2')[0].effort === 'high')
      check('3 candidates total, one focused re-read, one gap named', r.finalPass.candidates === 3 && r.finalPass.secondRead === true && r.finalPass.gaps.length === 1)
      check('exactly 2 final-pass findings stand (the rejected candidate is gone), the kept src/a.ts one carries the decider\'s severity', r.finalPass.findings.length === 2 && !r.finalPass.findings.some((f) => f.summary === 'not real') && r.finalPass.findings.some((f) => f.file === 'src/a.ts' && f.severity === 'blocker'))
      check('run is NOT clean and the gap-found finding is in remainingFindings', r.clean === false && r.remainingFindings.some((f) => f.phase === 'Final pass' && f.file === 'src/low.ts'))
      // F2: the final-checkpoint JSON's remainingFindings must be an ARRAY whose
      // items carry severity — never a collapsed string (a string reads back as
      // [] via pipeline-ledger.mjs's arrOrEmpty, recording 0 remaining findings
      // on exactly the runs that had real ones).
      const finalCk = calls.find((c) => c.label === 'checkpoint:final')
      const payload = finalCk && extractCheckpointPayload(finalCk.prompt)
      check(
        'checkpoint:final payload remainingFindings is a non-empty array whose items carry severity',
        !!payload && Array.isArray(payload.remainingFindings) && payload.remainingFindings.length > 0 && payload.remainingFindings.every((f) => f && typeof f.severity === 'string'),
        JSON.stringify(payload && payload.remainingFindings)
      )
    },
  },

  // ═══════════ O-series: mode: 'bugfix' ═══════════
  {
    name: "O1. bugfix: no UI file in the change -> the design-system lens is gated OFF and lensesRun says so",
    args: bugfixArgs({ uxSpecPath: 'ux.md' }), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    assert({ result: r, calls, logs }) {
      check('mode is recorded as bugfix', r.mode === 'bugfix')
      check('no design-system lens agent ran', byLabel(calls, 'review:design-system').length === 0 && byLabel(calls, 'review:').length === 6)
      check('lensesRun names the six lenses that ran and lacks design-system', r.lensesRun.length === 6 && !r.lensesRun.includes('design-system'))
      check('the gating is logged, not silent', logs.some((l) => /Design-system lens GATED OFF/.test(l)))
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'O1b. bugfix: a .tsx file in the change -> the design-system lens runs',
    args: bugfixArgs({
      uxSpecPath: 'ux.md',
      packages: [{ id: 'WP1', title: 'w', files: ['apps/web/app/x.tsx'], brief: 'b' }],
      mutationProbe: { targets: [{ file: 'apps/web/app/x.tsx', behavior: 'x', test: 'jest a' }] },
    }),
    commands: cmds, mutFiles: ['apps/web/app/x.tsx'],
    manifest: [
      { path: 'apps/web/app/x.tsx', status: 'modified', risk: 'HIGH', changedLines: 20 },
      { path: 'src/a.spec.ts', status: 'added', risk: 'LOW', changedLines: 30 },
    ],
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    assert({ result: r, calls, logs }) {
      check('the design-system lens ran as its own agent', byLabel(calls, 'review:design-system').length === 1 && byLabel(calls, 'review:').length === 7)
      check('lensesRun includes design-system', r.lensesRun.includes('design-system') && r.lensesRun.length === 7)
      check('the keep is logged with the UI file that earned it', logs.some((l) => /Design-system lens KEPT/.test(l) && /apps\/web\/app\/x\.tsx/.test(l)))
    },
  },
  {
    name: 'O2. bugfix: a finding two lenses reported skips pre-refutation; a single-lens HIGH-risk finding does not',
    args: bugfixArgs(), commands: cmds, manifest: twoHighManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    // opinions keep review order after dedupe — [src/a.ts, src/high2.ts, src/high3.ts]
    // — so index 2 marks the corroborated finding as mis-cited.
    firstRefuted: false, invalidIndexes: [2], overrides: { ...corroborationOverrides, 'red-audit': REDDEST },
    assert({ result: r, calls }) {
      check('corroboration was counted: two findings were reported by 2+ lenses', r.verify.corroborated === 2 && r.verify.corroboratedSkipped === 1)
      check('the corroborated finding carries corroboratedBy: 2', ([...(r.confirmedFindings || []), ...(r.plausibleFindings || [])].find((f) => f.file === 'src/a.ts') || {}).corroboratedBy === 2)
      check('no refuter was spent on the corroborated, well-cited HIGH-risk finding', byLabel(calls, 'refute-batch:src/a.ts').length === 0)
      check('a corroborated but MIS-CITED finding is pre-refuted anyway — corroboration never overrides the location signal', r.verify.locationInvalid === 1 && byLabel(calls, 'refute-batch:src/high3.ts').length === 1)
      check('the single-lens HIGH-risk finding WAS pre-refuted', byLabel(calls, 'refute-batch:src/high2.ts').length === 1 && r.verify.preRefuted === 2)
      check('the skipped finding went to the fixer, not to nowhere', r.verify.deferredToFixer === 1 && byLabel(calls, 'fix:src/a.ts').length === 1 && byLabel(calls, 'fix:src/high2.ts').length === 1 && byLabel(calls, 'fix:src/high3.ts').length === 1)
      houseRules(calls)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'O2b. A3 (owner ruling 2026-09-11): corroboration-skip is now general — feature mode, same corroboration fixture as O2, gets the SAME skip (previously bugfix-only, where it stayed pre-refuted and unannotated)',
    args: baseArgs('major'), commands: cmds, manifest: twoHighManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    firstRefuted: false, invalidIndexes: [2], overrides: { ...corroborationOverrides },
    assert({ result: r, calls }) {
      check('counting happens in feature mode too', r.verify.corroborated === 2)
      check('A3: the well-cited corroborated finding now skips pre-refutation in feature mode too', r.verify.corroboratedSkipped === 1)
      check('A3: it carries corroboratedBy: 2 in feature mode too', ([...(r.confirmedFindings || []), ...(r.plausibleFindings || [])].find((f) => f.file === 'src/a.ts') || {}).corroboratedBy === 2)
      check('no refuter was spent on the corroborated, well-cited HIGH-risk finding', byLabel(calls, 'refute-batch:src/a.ts').length === 0)
      check('a corroborated but MIS-CITED finding is still pre-refuted — corroboration never overrides the location signal', r.verify.locationInvalid === 1 && byLabel(calls, 'refute-batch:src/high3.ts').length === 1)
      check('the single-lens HIGH-risk finding WAS pre-refuted', byLabel(calls, 'refute-batch:src/high2.ts').length === 1 && r.verify.preRefuted === 2)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'O3. bugfix: the behavioral red bar is forced -> remediation runs, and a repro that still does not reproduce is a MAJOR finding',
    args: bugfixArgs(), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [],
    assert({ result: r, calls }) {
      check('bugfix forces the behavioral bar at major scale', r.redGate.remediateOn === 'behavioral' && r.redGate.structurallyRed === true && r.redGate.behaviorallyRed === false)
      check('the one allowed remediation round was spent', r.redGate.attempts === 2 && byLabel(calls, 'red-remediate').length === 1)
      check('the carried (red-gate) finding is major, not minor and not a blocker', r.confirmedFindings.some((f) => f.file === '(red-gate)' && f.severity === 'major' && /repro does not reproduce/.test(f.summary)))
      check('the probe still covers EVERY target', r.mutationProbe.probed === 2 && r.mutationProbe.skippedTargets.length === 0)
      check('run is NOT clean while the repro is unproven', r.clean === false)
    },
  },
  {
    name: 'O3b. feature mode, same red audit: the structural bar holds -> no remediation, and the shortfall is a MINOR note',
    args: baseArgs('major', { mutationProbe: undefined }), commands: cmds, manifest: highManifest, mutFiles: [],
    reviewFindings: [],
    assert({ result: r, calls }) {
      check('feature mode keeps the structural bar', r.redGate.remediateOn === 'structural' && r.redGate.attempts === 1)
      check('no remediation round was spent', byLabel(calls, 'red-remediate').length === 0)
      check('the shortfall is a minor note (no mutation probe to prove it)', r.confirmedFindings.some((f) => f.file === '(red-gate)' && f.severity === 'minor'))
    },
  },
  {
    name: 'O4. bugfix: revertFix on a tracked file reverts the fix to HEAD; on an untracked one it falls back to the standard mutation',
    args: bugfixArgs({
      mutationProbe: { targets: [
        { file: 'src/a.ts', behavior: 'boxed proration', test: 'jest a', revertFix: true },
        { file: 'src/new.ts', behavior: 'new helper', test: 'jest new', revertFix: true },
      ] },
    }),
    commands: cmds, mutFiles: ['src/a.ts', 'src/new.ts'],
    manifest: [...highManifest, { path: 'src/new.ts', status: 'untracked', risk: 'HIGH', changedLines: 22 }],
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    assert({ result: r, calls, logs }) {
      const tracked = byLabel(calls, 'mutate:src/a.ts')[0]
      const untracked = byLabel(calls, 'mutate:src/new.ts')[0]
      check('the tracked target gets the fix-revert procedure, on Sonnet at medium (token-class routing: probeModel)', /git show HEAD:src\/a\.ts/.test(tracked.prompt) && /MUST FAIL/.test(tracked.prompt) && tracked.model === 'claude-sonnet-5' && tracked.effort === 'medium')
      check('the revert and the restore are both forbidden to use git, and the backup is a file copy outside the repo', tracked.prompt.includes('Do NOT use `git checkout`, `git restore`, `git stash` or `git reset`') && tracked.prompt.includes('Again: NEVER `git checkout`/`restore`/`stash`/`reset`') && tracked.prompt.includes('Use a file copy (`cp`), never git') && /NEVER put the backup beside the file/.test(tracked.prompt))
      check('the untracked target gets the standard mutation prompt instead', !/git show HEAD:/.test(untracked.prompt) && /inject exactly ONE small, deliberate, behavior-breaking defect/.test(untracked.prompt))
      check('the fallback is recorded on the probe result', probeOf(r, 'src/a.ts').kind === 'revert-fix' && !probeOf(r, 'src/a.ts').fallback && probeOf(r, 'src/new.ts').kind === 'mutation' && probeOf(r, 'src/new.ts').fallback === 'untracked')
      check('the fallback is logged', logs.some((l) => /FELL BACK to the standard mutation probe/.test(l)))
      houseRules(calls)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'O4b. feature mode ignores revertFix (loudly) and probes as it always did',
    args: baseArgs('major', { mutationProbe: { targets: [{ file: 'src/a.ts', behavior: 'x', test: 'jest a', revertFix: true }] } }),
    commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts'],
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    assert({ result: r, calls, logs }) {
      check('the probe prompt is the standard mutation one', !/git show HEAD:/.test(byLabel(calls, 'mutate:src/a.ts')[0].prompt))
      check('the probe is recorded as a mutation with no fallback', probeOf(r, 'src/a.ts').kind === 'mutation' && !probeOf(r, 'src/a.ts').fallback)
      check('the ignored bugfix-only field is logged', logs.some((l) => /revertFix is a BUGFIX-MODE field/.test(l)))
    },
  },
  {
    name: 'O5. bugfix: the sibling sweep greps the defect shape then judges it, and a "defect" verdict reaches a fixer',
    args: bugfixArgs({ siblingPatterns: [{ pattern: 'findMany\\((?![^)]*tenantId)', note: 'query with no tenant scope' }] }),
    commands: cmds, mutFiles: ['src/a.ts', 'src/low.ts'],
    manifest: [...highManifest, { path: 'src/sib.ts', status: 'modified', risk: 'LOW', changedLines: 8 }],
    reviewFindings: twoFindings, firstRefuted: false, overrides: { 'red-audit': REDDEST },
    siblingHits: [{ pattern: 'findMany\\((?![^)]*tenantId)', file: 'src/sib.ts', line: 7, excerpt: 'prisma.order.findMany({ where: { status } })' }],
    assert({ result: r, calls }) {
      const grep = byLabel(calls, 'sibling-grep')
      const judge = byLabel(calls, 'sibling-judge')
      check('sibling-grep ran once on Sonnet at low under the Verify phase', grep.length === 1 && grep[0].model === 'claude-sonnet-5' && grep[0].effort === 'low' && grep[0].phase === 'Verify')
      check('sibling-judge ran once on Opus at medium under the Verify phase', judge.length === 1 && judge[0].model === 'claude-opus-5' && judge[0].effort === 'medium' && judge[0].phase === 'Verify')
      check('the sweep is recorded: one hit, one finding', r.siblingSweep.ran === true && r.siblingSweep.patterns === 1 && r.siblingSweep.hits === 1 && r.siblingSweep.findings === 1 && r.siblingSweep.skipped === null)
      check('the finding is review-shaped, tagged sibling-sweep, and was never pre-refuted', survived(r, (f) => f.file === 'src/sib.ts' && f.source === 'sibling-sweep' && f.line === 7) && byLabel(calls, 'refute-batch:src/sib.ts').length === 0)
      check('it reached a fix round', byLabel(calls, 'fix:src/sib.ts').length === 1)
      check('the sweep ran beside Verify and UI verify under one bracket', r.overlap.verifyWithUiVerify === true)
      houseRules(calls)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'O5b. bugfix with no siblingPatterns: neither sweep agent runs, and the skip is recorded',
    args: bugfixArgs(), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    assert({ result: r, calls }) {
      check('no sweep agent ran', byLabel(calls, 'sibling-').length === 0)
      check("the skip says why", r.siblingSweep.ran === false && r.siblingSweep.skipped === 'no-patterns' && r.siblingSweep.patterns === 0)
    },
  },
  {
    name: 'O5c. feature mode with siblingPatterns passed: the sweep never runs and says so',
    args: baseArgs('major', { siblingPatterns: [{ pattern: 'x', note: 'y' }] }), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    assert({ result: r, calls, logs }) {
      check('no sweep agent ran in feature mode', byLabel(calls, 'sibling-').length === 0)
      check('the result names the reason', r.siblingSweep.skipped === 'feature-mode' && r.siblingSweep.patterns === 1)
      check('the ignored bugfix-only arg is logged', logs.some((l) => /siblingPatterns is a BUGFIX-MODE argument/.test(l)))
    },
  },
  {
    name: 'P1a. sibling sweep: {regex, note} objects normalise to {pattern, note} — every real caller since 2026-09-08 passes regex, not pattern (E:533-534)',
    args: bugfixArgs({ siblingPatterns: [{ regex: 'findMany\\((?![^)]*tenantId)', note: 'query with no tenant scope' }] }),
    commands: cmds, mutFiles: ['src/a.ts', 'src/low.ts'], manifest: highManifest,
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    siblingHits: [],
    assert({ result: r, calls }) {
      check('supplied=1, patterns=1, ran=true (the {regex} entry was NOT dropped)', r.siblingSweep.supplied === 1 && r.siblingSweep.patterns === 1 && r.siblingSweep.ran === true, JSON.stringify(r.siblingSweep))
      check('the grep agent actually ran (proves the sweep is alive, not just recorded as such)', byLabel(calls, 'sibling-grep').length === 1)
    },
  },
  {
    name: 'P1b. sibling sweep: an entry with neither .pattern nor .regex is a BLOCKER ("siblingPatterns supplied but not usable"), never a silent no-patterns skip',
    args: bugfixArgs({ siblingPatterns: [{ bogus: 1 }] }),
    commands: cmds, mutFiles: ['src/a.ts', 'src/low.ts'], manifest: highManifest,
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    assert({ result: r, calls, logs }) {
      check('no sweep agent ran (0 kept of 1 supplied)', byLabel(calls, 'sibling-').length === 0 && r.siblingSweep.ran === false && r.siblingSweep.supplied === 1 && r.siblingSweep.patterns === 0)
      check('the skip reason is unusable-patterns, distinct from an honest no-patterns skip', r.siblingSweep.skipped === 'unusable-patterns')
      check('a (build-plan) blocker is present and survives to remainingFindings (UNFIXABLE)', r.remainingFindings.some((f) => f.file === '(build-plan)' && f.summary === 'siblingPatterns supplied but not usable'))
      check('an ERROR is logged, never a silent skip', logs.some((l) => /ERROR: siblingPatterns supplied but not usable — 1 supplied, 0 kept/.test(l)))
      check('run is NOT clean', r.clean === false)
    },
  },
  {
    name: 'P1c. GATE cwd enforcement (owner ruling 2026-09-11e, RUN-LOG train4-run-c): a gate that self-reports a cwd outside workdir is forced pass:false',
    args: baseArgs('small', { workdir: '/w', mutationProbe: undefined, uiVerify: undefined }),
    commands: cmds, manifest: lowManifest, mutFiles: [],
    reviewFindings: [], firstRefuted: false,
    overrides: {
      gate: () => ({ ...green(cmds), cwd: '/elsewhere' }),
      regate: () => ({ ...green(cmds), cwd: '/elsewhere' }),
      'final-gate': () => ({ ...green(cmds), cwd: '/elsewhere' }),
    },
    assert({ result: r, logs }) {
      check('the LAST gate is forced pass:false despite every command reporting green', r.gate.pass === false)
      check('the mismatch is logged with the actual cwd and the expected workdir', logs.some((l) => /Gate cwd mismatch/.test(l) && l.includes('/elsewhere') && l.includes('/w')))
      check('run is NOT clean', r.clean === false)
    },
  },
  {
    name: 'P1d. Jest command validation: --reporters=default not in LAST position is a BLOCKER before Baseline (RUN-LOG train4-run-a: "BOTH recorded final Jest gates were void")',
    args: baseArgs('small', {
      mutationProbe: undefined, uiVerify: undefined,
      verifyCommands: { perRound: ['npx jest --reporters=default src/x'], final: ['npx jest --reporters=default src/x'] },
    }),
    commands: ['npx jest --reporters=default src/x'], manifest: lowManifest, mutFiles: [],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r }) {
      check('a (build-plan) blocker names the reporters-position defect', r.remainingFindings.some((f) => f.file === '(build-plan)' && /--reporters=default before its last argument/.test(f.summary)))
      check('run is NOT clean', r.clean === false)
    },
  },
  {
    name: "P1e. Jest command validation: a target matching ONLY a file this run's own plan will create, with no --passWithNoTests, is a BLOCKER",
    args: baseArgs('small', {
      mutationProbe: undefined, uiVerify: undefined,
      verifyCommands: { perRound: ['npx jest src/a.ts'], final: ['npx jest src/a.ts'] },
    }),
    commands: ['npx jest src/a.ts'], manifest: lowManifest, mutFiles: [],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r }) {
      check("a (build-plan) blocker names the missing-target defect", r.remainingFindings.some((f) => f.file === '(build-plan)' && /target path\(s\) are only files this run's own plan will create/.test(f.summary)))
      check('run is NOT clean', r.clean === false)
    },
  },
  {
    name: "O6. bugfix: the radius pack is every lens's evidence — containment for all but scope-coverage — and harness-check notes reach the test authors",
    args: bugfixArgs(), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], overrides: { 'red-audit': REDDEST },
    harnessIssues: [
      { file: 'src/a.spec.ts', line: 12, issue: 'the mocked OrdersService has no computeTotals method', remedy: 'add computeTotals to the mock' },
      // A shared fixture NO test package declares — it must still reach an author.
      { file: 'test/factories.ts', line: 3, issue: 'the order factory omits the newly required tenantId', remedy: 'add tenantId to the factory' },
    ],
    assert({ result: r, calls }) {
      const pack = byLabel(calls, 'radius-pack')
      const hc = byLabel(calls, 'harness-check')
      check('radius-pack ran once on Sonnet at low in the Gate & Review phase', pack.length === 1 && pack[0].model === 'claude-sonnet-5' && pack[0].effort === 'low' && pack[0].phase === 'Gate & Review')
      check('the pack is recorded as built over the work package files', r.radiusPack.built === true && r.radiusPack.truncated === false && r.radiusPack.skipped === null)
      check('EVERY review lens prompt carries the pack itself', byLabel(calls, 'review:').length === 6 && byLabel(calls, 'review:').every((c) => c.prompt.includes(PACK_TEXT)))
      // Containment would delete scope-coverage's whole job (L-029), so that one lens
      // gets the pack as a starting map and keeps its beyond-the-diff mandate.
      const sc = byLabel(calls, 'review:scope-coverage')
      check('scope-coverage is EXEMPT from the containment clause and gets the beyond-the-diff wording instead', sc.length === 1 && !sc[0].prompt.includes(CONTAINMENT) && !sc[0].prompt.includes('PRIMARY EVIDENCE') && sc[0].prompt.includes(BEYOND))
      check('every OTHER lens keeps the containment clause and never sees the beyond wording', byLabel(calls, 'review:').filter((c) => c.label !== 'review:scope-coverage').every((c) => c.prompt.includes('PRIMARY EVIDENCE') && c.prompt.includes(CONTAINMENT) && !c.prompt.includes(BEYOND)))
      check('the pack sits AFTER the shared run prefix and BEFORE the lens role line (so the prefix still caches)', byLabel(calls, 'review:').every((c) => c.prefixFirst && c.prompt.indexOf(PACK_TEXT) > 0 && c.prompt.indexOf(PACK_TEXT) < c.prompt.indexOf('You are a senior code reviewer')))
      check('harness-check ran once on Sonnet at low in the Baseline phase', hc.length === 1 && hc[0].model === 'claude-sonnet-5' && hc[0].effort === 'low' && hc[0].phase === 'Baseline')
      check("its issue text reaches the owning test package's author prompt, verbatim", byLabel(calls, 'tests:TP1').length === 1 && /HARNESS NOTES — fix these in the same edit:/.test(byLabel(calls, 'tests:TP1')[0].prompt) && byLabel(calls, 'tests:TP1')[0].prompt.includes('the mocked OrdersService has no computeTotals method'))
      check('the orphan issue is routed to the FIRST test package under its own label', byLabel(calls, 'tests:TP1')[0].prompt.includes('SHARED HARNESS (owned by no package) — fix in your edit:') && byLabel(calls, 'tests:TP1')[0].prompt.includes('the order factory omits the newly required tenantId'))
      check('the check is recorded with BOTH issues, and the note says where the orphan went', r.harnessCheck.ran === true && r.harnessCheck.issues.length === 2 && r.harnessCheck.skipped === null && /routed to the first test package \(TP1\)/.test(r.harnessCheck.note))
      houseRules(calls)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'O6b. bugfix: a dead radius packer -> no pack section anywhere, and the lenses run exactly as in feature mode',
    args: bugfixArgs(), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], radiusPack: null, overrides: { 'radius-pack': null, 'red-audit': REDDEST },
    assert({ result: r, calls, logs }) {
      check('the pack is recorded as not built, with the reason', r.radiusPack.built === false && r.radiusPack.skipped === 'agent-died')
      check('no review prompt claims a pack — neither half of the rule appears', byLabel(calls, 'review:').length === 6 && byLabel(calls, 'review:').every((c) => !c.prompt.includes('PRIMARY EVIDENCE') && !c.prompt.includes('RADIUS PACK') && !c.prompt.includes(CONTAINMENT) && !c.prompt.includes(BEYOND)))
      check('the loss is logged', logs.some((l) => /Radius pack UNUSABLE/.test(l)))
    },
  },
  {
    name: 'O6c. bugfix: a TRUNCATED pack is discarded — a partial diff must never read as the whole change',
    args: bugfixArgs(), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], overrides: { 'radius-pack': { pack: PACK_TEXT, truncated: true, files: ['src/a.ts'] }, 'red-audit': REDDEST },
    assert({ result: r, calls }) {
      check('truncated is recorded and the pack is not used', r.radiusPack.built === false && r.radiusPack.truncated === true && r.radiusPack.skipped === 'truncated')
      check('no review prompt carries the partial pack, under either half of the rule', byLabel(calls, 'review:').every((c) => !c.prompt.includes('PRIMARY EVIDENCE') && !c.prompt.includes(PACK_TEXT) && !c.prompt.includes(BEYOND)))
    },
  },
  {
    name: 'O7. IDENTITY GUARD: scenario A with no mode arg -> not one bugfix agent, not one bugfix prompt section',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false,
    // A3: report each finding from exactly one lens — see scenario A's note.
    overrides: { 'review:': (label) => ({ findings: label.startsWith('review:correctness') ? twoFindings : [] }) },
    assert({ result: r, calls }) {
      check('mode defaults to feature', r.mode === 'feature')
      check('none of the bugfix labels appear', NEW_LABELS.every((l) => byLabel(calls, l).length === 0), JSON.stringify(calls.map((c) => c.label).filter((l) => NEW_LABELS.includes(l))))
      check('no prompt in the whole run contains PRIMARY EVIDENCE', calls.every((c) => !c.prompt.includes('PRIMARY EVIDENCE')))
      check('no prompt contains a HARNESS NOTES section or a fix-revert procedure', calls.every((c) => !c.prompt.includes('HARNESS NOTES') && !c.prompt.includes('git show HEAD:')))
      check('the bugfix stages are recorded as not applicable, never as clean results', r.radiusPack.skipped === 'feature-mode' && r.siblingSweep.skipped === 'no-patterns' && r.harnessCheck.skipped === 'feature-mode' && r.radiusPack.built === false && r.siblingSweep.ran === false && r.harnessCheck.ran === false)
      check('the feature-mode red bar, lens set and refutation are untouched', r.redGate.remediateOn === 'structural' && r.lensesRun.length === 6 && r.verify.preRefuted === 1 && r.verify.corroboratedSkipped === 0)
      check('no finding carries corroboratedBy', r.confirmedFindings.every((f) => !('corroboratedBy' in f)))
      houseRules(calls)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },

  // ═══════════ P-series: C1 checkpoints + C2 PHASE/LABEL attribution ═══════════
  // Same shape as scenario B (no HIGH-risk file, no findings): every phase's
  // endPhase() fires exactly once, which is what makes "one checkpoint per ran
  // phase, plus one final" a checkable equality rather than an inequality.
  {
    name: 'A10. checkpoint idempotency key (owner ruling 2026-09-11): every checkpoint payload (per-phase and final) carries ${runId}:${phase}:${attempt}, unique per call, and the per-phase card carries a bounded result-so-far built by the SAME summary builder the final checkpoint uses',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r, calls }) {
      const keys = checkpointIdempotencyKeys(calls)
      check('every checkpoint call (per-phase and final) carries a non-empty idempotencyKey', keys.length > 0 && keys.every((k) => typeof k.key === 'string' && k.key.length > 0))
      check('every key has the ${runId}:${phase}:${attempt} shape, attempt=1 (no phase repeats in a single pass)', keys.every((k) => /^[^:]+:.+:1$/.test(k.key)))
      check('every key is unique across the whole run', new Set(keys.map((k) => k.key)).size === keys.length)
      check('the final checkpoint\'s key uses the "final" phase segment', keys.some((k) => k.label === 'checkpoint:final' && /:final:1$/.test(k.key)))
      const firstPhasePayload = extractCheckpointPayload(byLabel(calls, 'checkpoint:')[0].prompt)
      check('the per-phase card carries a bounded resultSoFar (the SAME summary builder as the final checkpoint) with its own phaseReport and remainingFindings', !!firstPhasePayload && !!firstPhasePayload.resultSoFar && Array.isArray(firstPhasePayload.resultSoFar.phaseReport) && Array.isArray(firstPhasePayload.resultSoFar.remainingFindings) && typeof firstPhasePayload.resultSoFarTruncated === 'boolean')
      check('resultSoFar never claims the run is clean mid-run', firstPhasePayload.resultSoFar.clean === null)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'E4. checkpoint attempt seeding from a resume (owner ruling 2026-09-11, wave 3): args.priorCheckpoints carries the highest attempt already written for a phase -> that phase\'s NEXT checkpoint continues the count instead of restarting at 1',
    args: baseArgs('major', { priorCheckpoints: [{ phase: 'Baseline', attempt: 1 }] }), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r, calls }) {
      const keys = checkpointIdempotencyKeys(calls)
      const baseline = keys.find((k) => k.label === 'checkpoint:Baseline')
      check('the Baseline checkpoint continues from the seeded attempt (attempt=2, not 1)', !!baseline && /:Baseline:2$/.test(baseline.key), JSON.stringify(baseline))
      const others = keys.filter((k) => k.label !== 'checkpoint:Baseline')
      check('every OTHER phase is unaffected and still starts at attempt 1', others.every((k) => /:1$/.test(k.key)), JSON.stringify(others))
      check('every key is still unique across the whole run', new Set(keys.map((k) => k.key)).size === keys.length)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'P1. C1 checkpoints: one Haiku@low checkpoint per ran phase plus one final, exactly one snapshot-commit prompt, every prompt tagged PHASE/LABEL',
    args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    assert({ result: r, calls }) {
      const ck = byLabel(calls, 'checkpoint:')
      check('one checkpoint per ran phase, plus the final one', ck.length === r.phaseReport.filter((p) => p.ran).length + 1, `checkpoints=${ck.length} ranPhases=${r.phaseReport.filter((p) => p.ran).length}`)
      check('every checkpoint call runs on Haiku at low effort', ck.every((c) => c.model === 'claude-haiku-4-5' && c.effort === 'low'), JSON.stringify(ck.map((c) => [c.model, c.effort])))
      check('exactly one checkpoint prompt carries the snapshot-commit message', ck.filter((c) => c.prompt.includes('wip(pipeline):')).length === 1)
      check('resultObj.checkpoints is recorded and matches the checkpoint calls made', Array.isArray(r.checkpoints) && r.checkpoints.length === ck.length)
      // F1: the final checkpoint writes result.json FLAT — top-level phaseReport/
      // mode/scale/clean, never wrapped in a nested `summary` key.
      const finalCk = calls.find((c) => c.label === 'checkpoint:final')
      const payload = finalCk && extractCheckpointPayload(finalCk.prompt)
      check(
        'checkpoint:final payload is FLAT (top-level phaseReport/mode/scale/clean, no summary wrapper)',
        !!payload && Array.isArray(payload.phaseReport) && 'mode' in payload && 'scale' in payload && 'clean' in payload && !('summary' in payload),
        JSON.stringify(payload && Object.keys(payload))
      )
      check('checkpoint:final payload records checkpointTruncated (not `truncated`)', !!payload && typeof payload.checkpointTruncated === 'boolean' && !('truncated' in payload))
      // F3: the snapshot-commit prompt stages only tracked changes plus this
      // run's own directory — NEVER a blanket `git add -A`. The prompt is
      // allowed to MENTION "git add -A" once, only as the explicit prohibition
      // ("NEVER run `git add -A`") — never as an instruction to actually run it.
      const snapshotCk = ck.find((c) => c.prompt.includes('wip(pipeline):'))
      const badGitAddA = calls.filter((c) => c.prompt.split('NEVER run `git add -A`').join('').includes('git add -A'))
      check('no prompt in the run ever instructs an agent to actually run `git add -A`', badGitAddA.length === 0, JSON.stringify(badGitAddA.map((c) => c.label)))
      check('the snapshot-commit prompt stages tracked changes plus only the run dir', !!snapshotCk && snapshotCk.prompt.includes('git add -u') && snapshotCk.prompt.includes(`git add "${CK_RUN_DIR}"`) && snapshotCk.prompt.includes('NEVER run `git add -A`'))
      tagRules(calls)
      repoNoteTagRules(calls)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
    },
  },
  {
    name: 'P2. args.runDir absent -> legacy path: zero checkpoint calls, and every OTHER call is byte-identical to the runDir-present run (P1)',
    args: baseArgs('major', { runDir: '' }), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: [], firstRefuted: false,
    async assert({ result: r, calls }) {
      check('no checkpoint agent ran', byLabel(calls, 'checkpoint:').length === 0)
      check('no checkpoints recorded on the result either', Array.isArray(r.checkpoints) && r.checkpoints.length === 0)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
      // Re-run the identical scenario WITH runDir (P1's own config) and diff the
      // non-checkpoint calls: label, model, effort and prompt text must all match
      // — the tag is present in both paths, so nothing about it may differ.
      const withRunDir = await run({
        args: baseArgs('major'), commands: cmds, manifest: lowManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
        reviewFindings: [], firstRefuted: false,
      })
      const a = calls
      const b = withRunDir.calls.filter((c) => !c.label.startsWith('checkpoint:'))
      check('same number of non-checkpoint calls in both paths', a.length === b.length, `${a.length} vs ${b.length}`)
      check('every non-checkpoint call is byte-identical between the two paths (label, model, effort, prompt)', a.length === b.length && a.every((c, i) => c.label === b[i].label && c.model === b[i].model && c.effort === b[i].effort && c.prompt === b[i].prompt), JSON.stringify(a.filter((c, i) => b[i] && (c.label !== b[i].label || c.prompt !== b[i].prompt)).map((c) => c.label)))
    },
  },

  // ═══════════ P5: final pass reordered before the LAST budgeted round (major scale) ═══════════
  // Owner ruling 2026-09-11e (package P5, E:~4959 fix loop, E:~5100 runFinalPass, E:~5216
  // terminal call). Reuses scenario G's exact dispute mechanic (fixer disputes src/low.ts
  // on round 1, the slate upholds it) purely to FORCE a second fix round — CFG.maxFixRounds
  // is a static 2, so "the last budgeted round" is always round 2 in this harness, whichever
  // scenario reaches it. A `finalCandidates` override hands the reader one fresh candidate
  // (src/c.ts) that only a pre-last-round final pass could fold into round 2's fix plan.
  {
    name: 'P5a. major scale: the final pass runs BEFORE the last budgeted round\'s fix-plan, tags its findings pre-last-round, and they get a real fix — the terminal final pass still runs after',
    args: baseArgs('major'), commands: cmds, manifest: highManifest, mutFiles: ['src/a.ts', 'src/low.ts'],
    reviewFindings: twoFindings, firstRefuted: false, disputeRefuted: true, secondRefuted: false, judgeRefuted: false,
    fixResponder: (label, n) => (label === 'fix:src/low.ts' && n === 1 ? { fixed: [], skipped: [], disputed: [{ summary: 'off by one', reason: 'looks intended' }], filesChanged: [] } : null),
    // Returns the candidate only on the FIRST 'final-pass:read' (the pre-last-round
    // call) — the terminal call's reader would not re-report a defect round 2's
    // fixer already fixed, so a naive "always return it" mock would fail the run
    // for a reason that has nothing to do with the reorder under test.
    finalCandidates: (() => {
      let reads = 0
      return (label) => {
        if (label !== 'final-pass:read') return []
        reads++
        return reads === 1 ? [{ file: 'src/c.ts', line: 1, severity: 'major', summary: 'pre-last-round finding', detail: 'd', fixComplexity: 'mechanical' }] : []
      }
    })(),
    assert({ result: r, calls }) {
      check('two fix rounds ran (scenario G\'s dispute mechanic), so round 2 is genuinely the last budgeted round', r.fixRounds === 2, JSON.stringify(r.fixRounds))
      const pkg = calls.map((c, i) => ({ ...c, i })).filter((c) => c.label === 'final-pass:package')
      const r2 = calls.findIndex((c) => c.label === 'fix-plan:r2')
      check('final pass ran exactly twice: once before round 2, once as the terminal sign-off read', pkg.length === 2, JSON.stringify(pkg.map((c) => c.i)))
      check('round 2\'s fix-plan label sits strictly BETWEEN the two final-pass runs (pre-last-round first, terminal after)', pkg.length === 2 && r2 !== -1 && pkg[0].i < r2 && r2 < pkg[1].i, `final-pass@${pkg.map((c) => c.i)} vs fix-plan:r2@${r2}`)
      check('the pre-last-round final-pass finding (src/c.ts) reached an actual fixer in round 2, not just remainingFindings', byLabel(calls, 'fix:src/c.ts').length === 1)
      check('run ends clean', r.clean === true, JSON.stringify(r.remainingFindings.map((f) => f.file + ': ' + f.summary)))
      // A10/P1 invariant, extended to the P5 reorder path: 'Final pass' fires twice
      // (pre-last-round + terminal) but must checkpoint exactly once — the
      // pre-last-round call passes { skipCheckpoint: true } to endPhase().
      const finalPassCk = calls.filter((c) => c.label === 'checkpoint:Final pass')
      check('exactly one checkpoint fires for the "Final pass" phase title even though final-pass ran twice', finalPassCk.length === 1, `checkpoints=${finalPassCk.length}`)
      // finding #2 (execute:2): the pre-last-round call's own finalPassResult detail
      // must survive as priorPasses[0] once the terminal call overwrites finalPassResult.
      check('finalPass.priorPasses has exactly one snapshot (the pre-last-round call)', Array.isArray(r.finalPass.priorPasses) && r.finalPass.priorPasses.length === 1, JSON.stringify(r.finalPass.priorPasses))
      const prior = r.finalPass.priorPasses[0] || {}
      check('priorPasses[0].origin is "pre-last-round"', prior.origin === 'pre-last-round', JSON.stringify(prior.origin))
      check('priorPasses[0].findings deep-equals the findings the pre-last-round pass produced', JSON.stringify(prior.findings) === JSON.stringify([{ file: 'src/c.ts', line: 1, severity: 'major', summary: 'pre-last-round finding', detail: 'd', fixComplexity: 'mechanical', phase: 'Final pass', decision: 'dry', unadjudicated: false }]), JSON.stringify(prior.findings))
      check('the terminal call\'s own finalPass.origin is "terminal" (top-level shape unchanged)', r.finalPass.origin === 'terminal', JSON.stringify(r.finalPass.origin))
    },
  },
  {
    name: 'P5b. small scale: the reorder never fires — final pass still runs neither before round 2 nor at all, so call order is unchanged',
    args: baseArgs('small', { mutationProbe: undefined, uiVerify: undefined }), commands: cmds, manifest: highManifest, mutFiles: [],
    reviewFindings: twoFindings, firstRefuted: false, disputeRefuted: true, secondRefuted: false, judgeRefuted: false,
    fixResponder: (label, n) => (label === 'fix:src/low.ts' && n === 1 ? { fixed: [], skipped: [], disputed: [{ summary: 'off by one', reason: 'looks intended' }], filesChanged: [] } : null),
    assert({ result: r, calls }) {
      check('two fix rounds still ran (same dispute mechanic), so a last-round reorder was structurally possible', r.fixRounds === 2, JSON.stringify(r.fixRounds))
      check('no final-pass call ran anywhere in the run — small scale is untouched by the reorder', byLabel(calls, 'final-pass').length === 0 && r.finalPass.ran === false && r.finalPass.skipped === 'small-scale')
      check('finding #2 (execute:2): finalPass.priorPasses deep-equals [] when runFinalPass never ran', Array.isArray(r.finalPass.priorPasses) && r.finalPass.priorPasses.length === 0, JSON.stringify(r.finalPass.priorPasses))
    },
  },
]

for (const s of scenarios) {
  console.log(`\n${s.name}`)
  try {
    // E5: a scenario may opt into the cascade-enabled source variant (runCascade)
    // instead of the default run(); every other scenario is untouched.
    const out = await (s.runner || run)(s)
    // await: P2's assert re-runs the harness internally (async) to diff two paths.
    // A no-op await for every synchronous assert() that came before it.
    await s.assert(out)
    if (showCalls) for (const c of out.calls) console.log(`     ${c.phase.padEnd(15)} ${c.label.padEnd(28)} ${String(c.model).padEnd(18)} ${c.effort}`)
  } catch (e) {
    failures++
    console.log(`  FAIL scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`)
  }
}

// SOURCE SCAN (owner ruling — pipeline.js runs in a sandbox with NO host
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
// pipeline.js does not lean on near any of the banned tokens.
console.log('\nSOURCE SCAN. pipeline.js never touches a host global the sandbox does not provide')
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
// Self-test the scanner itself (repro-first): pipeline.js.bak-2026-09-11e is
// the PRE-FIX capFableBrief with real Buffer.from/Buffer.byteLength calls. If
// the scanner did not flag that text, it would not have caught the sandbox
// crash either — this is the proof the check above is doing real work.
const pipelineBakPath = path.join(here, '..', 'pipeline.js.bak-2026-09-11e')
const pipelineBakHits = fs.existsSync(pipelineBakPath) ? scanHostGlobals(fs.readFileSync(pipelineBakPath, 'utf8')) : null
check(
  'self-test: pipeline.js.bak-2026-09-11e (pre-fix, real Buffer.from/Buffer.byteLength calls) IS flagged for Buffer.',
  Array.isArray(pipelineBakHits) && pipelineBakHits.some((h) => h.startsWith('Buffer.@')),
  pipelineBakHits ? pipelineBakHits.join(', ') : `missing ${pipelineBakPath}`,
)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DRY-RUN SCENARIOS PASSED')
process.exit(failures ? 1 : 0)
