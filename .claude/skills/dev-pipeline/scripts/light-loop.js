export const meta = {
  name: 'light-loop',
  description: 'Bounded-work loop: ground the brief, build, pack, review, fix, re-check, close out.',
  phases: [
    { title: 'Baseline', detail: 'host-contention preflight + brief grounding' },
    { title: 'Implement', detail: 'one Sonnet builder per package' },
    { title: 'Gate & Review', detail: 'review pack + correctness lens (two lenses if spansSkillAndRepo)' },
    { title: 'Fix', detail: 'Fable fix plan, Sonnet/Opus executors' },
    { title: 'Final pass', detail: 'pack refresh + one Opus re-check, up to maxFixRounds' },
  ],
}

// ── light-loop.js — bounded-work Workflow script ────────────────────────────
// Design: routeflow/.claude/pipeline/skills-design-2026-09-10.md §3.
// Ruling:  routeflow/.claude/pipeline/skills-upgrade-ruling-2026-09-10.md C1.
// Brief:   routeflow/.claude/pipeline/skills-build-brief-2026-09-10.md §3.
//
// This is NOT a `mode:'light-loop'` fork of pipeline.js — it is a separate,
// smaller Workflow script for bounded work. It shares pipeline.js's PROMPT
// CONVENTIONS (RUN_PREFIX byte-identical per run, PHASE/LABEL tag on every
// agent() call, per-phase Haiku checkpoints) so session-usage.mjs attribution
// and the ledger need no new parsing.
//
// ALIAS RULE (documented once, load-bearing for the dry-run's PHASE_ORDER
// assertion): every agent() call's PHASE tag is one of the ten canonical
// pipeline-ledger.mjs PHASE_ORDER names. The three steps the design table
// marks with no alias of their own (Pack, Fix brief, Result) are folded into
// the PHASE_ORDER name of the step they materially serve:
//   Pack (first pass, before Review)   -> 'Gate & Review'
//   Pack (refresh, inside Re-check)    -> 'Final pass'
//   Fix brief                          -> 'Fix'
//   Result (the closing Haiku write)   -> 'Final pass'
// This is strictly stronger than the table's dash notation (every alias this
// run ever emits is a real PHASE_ORDER member) and is what the dry-run checks.
const PHASE_ORDER = [
  'Baseline', 'Author tests', 'Red gate', 'Implement', 'Gate & Review',
  'Verify', 'UI verify', 'Mutation probe', 'Fix', 'Final pass',
]

// Full model ids only — never a bare alias (model-routing/references/ROUTING-PLAN.md §1).
const MODEL = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
}

// Static per-phase model/effort labels for phaseReport (F9, owner ruling
// 2026-09-11) -- mirrors pipeline.js's PHASE_MODELS/PHASE_EFFORTS: a phase
// that mixes tiers says so, because "Fix: 40k tokens" means something
// different at Sonnet prices than at Opus prices.
const PHASE_MODELS = {
  Baseline: MODEL.haiku,
  Implement: `${MODEL.sonnet} (medium; high for a HIGH-risk package)`,
  'Gate & Review': `${MODEL.sonnet} (pack) + ${MODEL.opus} (review lens(es))`,
  Fix: `${MODEL.sonnet} (fix-brief, mechanical/designed-low executors) + ${MODEL.fable} (fix-plan; ${MODEL.opus} fallback) + ${MODEL.opus} (HIGH-risk executors)`,
  'Final pass': `${MODEL.sonnet} (pack refresh) + ${MODEL.opus} (recheck) + ${MODEL.haiku} (result)`,
}
const PHASE_EFFORTS = {
  Baseline: 'low',
  Implement: 'medium (high for a HIGH-risk package)',
  'Gate & Review': 'low pack / high review',
  Fix: 'low fix-brief / high fix-plan (xhigh fallback) / low-medium-high executors by tier',
  'Final pass': 'low pack refresh / high recheck / low result',
}

// FABLE BRIEF CAP (F5, owner ruling 2026-09-11; mirrors pipeline.js's
// capFableBrief()/CFG.caps.fableBriefBytes exactly). Fable decides from a
// compact brief and never gathers, so a brief over the cap is truncated HERE,
// in the script, rather than trusted to fit on its own -- the packager that
// built it gets the marker as a note to tighten next round. Applied to the
// brief text whichever model actually reads it (Fable, or its Opus fallback
// when Fable declines): it is the same content either way.
const FABLE_BRIEF_CAP_BYTES = 8192
// Twin of pipeline.js's utf8ByteLength/utf8Truncate (kept byte-for-byte
// identical — see the comment there). Buffer-free so a cut never lands
// inside a multi-byte UTF-8 sequence or a surrogate pair.
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
  const cap = FABLE_BRIEF_CAP_BYTES
  if (utf8ByteLength(promptText) <= cap) return { text: promptText, truncated: false }
  const marker = '\n\n[truncated at 8 KB — packager must tighten]'
  const keepBytes = Math.max(0, cap - utf8ByteLength(marker))
  return { text: utf8Truncate(promptText, keepBytes) + marker, truncated: true }
}

// OPUS TOOL-CALL CAP (F8, owner ruling 2026-09-11; mirrors pipeline.js's
// opusCapped()/CFG.caps.opusToolCalls). Applied to the Opus re-check reader
// and any Opus-tier fix executor -- both open source files freely, so both
// need the budget clause. The Fable fix-planner's Opus FALLBACK
// (fix-plan:fallback) stays EXEMPT: it decides from the brief text alone,
// zero repo access, so a tool-call cap is moot for it.
const OPUS_TOOL_CALL_CAP = 12
function withOpusCap(promptText) {
  return `${promptText}\n\nRead the pack / brief provided. Open a source file only for a hunk it cites. Hard cap: ${OPUS_TOOL_CALL_CAP} tool calls; if you need more, stop and report \`needsMoreContext\` with what is missing.`
}

// ---------- args ----------
const _args = args && typeof args === 'object' ? args : {}
const briefPath = _args.briefPath
const runDir = _args.runDir
if (!briefPath) throw new Error('args.briefPath is required (path to the brief this loop reads; S1 already produced it)')
if (!runDir) throw new Error('args.runDir is required (this loop\'s own directory: <runDir>/phases/*.json, <runDir>/review-pack.md, <runDir>/result.json)')
const workdir = typeof _args.workdir === 'string' ? _args.workdir : ''
const lessonsPath = typeof _args.lessonsPath === 'string' ? _args.lessonsPath : ''
const startedAt = typeof _args.startedAt === 'string' ? _args.startedAt : null
const concurrentEditors = !!_args.concurrentEditors
// F6 (owner ruling 2026-09-11): concurrentEditors:true ALONE now means
// worktree isolation for Build/Execute fan-out -- 'worktree' is the default
// the instant the caller says packages/fixes are independent; 'shared' only
// wins when the caller passes it EXPLICITLY (an opt-OUT, never the default).
// A shared file living in a worktree agent's scope is still a
// brief-authoring bug, never inferred here from a path prefix.
const isolationMode = _args.isolation === 'shared' ? 'shared' : 'worktree'
const spansSkillAndRepo = !!_args.spansSkillAndRepo
const maxFixRounds = Number.isInteger(_args.maxFixRounds) && _args.maxFixRounds > 0 ? _args.maxFixRounds : 2
// Only meaningful when concurrentEditors is also true -- see buildOnePackage/executeOneFix.
const wantWorktree = concurrentEditors && isolationMode === 'worktree'

// ---------- prompt scaffolding (mirrors pipeline.js RUN_PREFIX/ROLE_TAG) ----
const REPO_NOTE =
  (workdir
    ? `ALL work happens in the git worktree at "${workdir}" -- your process may start elsewhere, so \`cd\` into it before ANY command and use ABSOLUTE paths under it for every file read/edit. Do not touch files outside it. `
    : 'You are working in the current directory, a git working tree. ') +
  'Never delete, move, stash, checkout, or "tidy" any file you did not create. ' +
  'Never run `git add -A`, `git stash`, `git checkout --`, `git reset --hard`, or `git push --force`. ' +
  'Edit files surgically: change only the lines the task needs.'
const ARTIFACT_NOTE = [
  `- brief (the ground truth for this run): "${briefPath}"`,
  lessonsPath ? `- lessons register (apply every entry relevant to what you review, write, or fix; cite the entry id when one changes your conclusion): "${lessonsPath}"` : '',
].filter(Boolean).join('\n')
const GROUNDED_NOTE =
  'Before reporting, audit each claim against a tool result from this session. Report only what you can point to evidence for; if something is not verified, say so explicitly. If a command failed or was skipped, say so with the output.'
const SCRATCH_NOTE = 'Scratch files only under the OS temp directory, never inside the repo.'
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
// Byte-identical for every agent in this run so agents sharing model+effort in
// the same wave read it from the prompt cache instead of paying for it again.
function RUN_PREFIX() {
  return [REPO_NOTE, ARTIFACT_NOTE, GROUNDED_NOTE, SCRATCH_NOTE, SCOPE_NOTE, BATCH_NOTE]
    .filter(Boolean)
    .join('\n')
}
const TAG = (phase, label) => `PHASE: ${phase} · LABEL: ${label}`
// Every prompt opens with RUN_PREFIX(), then the tag, then role/task -- so the
// tag never breaks the shared byte-prefix agents in one wave rely on for the
// cache. Every call site below goes through this, never bare agent().
function askAgent(prompt, opts) {
  const o = opts || {}
  return agent(`${RUN_PREFIX()}\n${TAG(o.phase, o.label)}\n${prompt}`, o)
}
// One lightweight call per (model, effort) pair before a wave that shares it,
// so the real calls in that wave land on a warm cache instead of each writing
// its own copy (agents launched in the same instant all miss -- measured,
// ROUTING-PLAN.md §3). Never counted as a phase agent for checkpoint math.
const warmedThisRun = new Set()
async function warmUp(model, effort, phase) {
  const key = `${model}:${effort}`
  if (warmedThisRun.has(key)) return
  warmedThisRun.add(key)
  await askAgent('Reply with exactly: OK', { label: 'warmup', phase, model, effort })
}
async function warmUpWave(pairs, phase) {
  for (const [model, effort] of pairs) await warmUp(model, effort, phase)
}

// ---------- schemas ----------
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
    file: { type: 'string' },
    line: { type: 'number' },
    summary: { type: 'string' },
    evidence: { type: 'string' },
    scenario: { type: 'string', description: 'concrete input/state that reaches the wrong output or crash' },
  },
  required: ['severity', 'file', 'summary', 'evidence', 'scenario'],
}
const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    contended: { type: 'boolean', description: 'true if the host is too busy to run this loop reliably right now (process/CPU contention)' },
    treeClean: { type: 'boolean' },
    resumeWritten: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['contended', 'treeClean', 'resumeWritten', 'note'],
}
const GROUND_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'true only if every file/script/sha the brief names actually exists' },
    missing: { type: 'array', items: { type: 'string' } },
    packages: {
      type: 'array',
      description: 'the brief\'s own package list, echoed back so Build reads it from here, not the brief again',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, brief: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string', enum: ['HIGH', 'LOW'] },
        },
        required: ['id', 'title', 'brief', 'files'],
      },
    },
    note: { type: 'string' },
  },
  required: ['ok', 'missing', 'packages', 'note'],
}
const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    packageId: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    gates: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, pass: { type: 'boolean' }, summary: { type: 'string' } }, required: ['command', 'pass', 'summary'] } },
    findings: { type: 'array', items: FINDING_SCHEMA },
    deviations: { type: 'array', items: { type: 'string' }, description: 'any departure from the brief -- a deviation is a finding, never an unlogged improvisation' },
  },
  required: ['packageId', 'filesChanged', 'gates', 'findings', 'deviations'],
}
const PACK_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean' }, path: { type: 'string' },
    bytes: { type: 'number' }, truncated: { type: 'boolean' }, note: { type: 'string' },
  },
  required: ['written', 'path', 'bytes', 'truncated', 'note'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, verdict: { type: 'string', enum: ['HELD', 'REFUTED'] }, file: { type: 'string' }, line: { type: 'number' } }, required: ['claim', 'verdict', 'file'] } },
    findings: { type: 'array', items: FINDING_SCHEMA },
    verdict: { type: 'string', enum: ['SHIP', 'FIX-FIRST', 'BLOCK'] },
  },
  required: ['claims', 'findings', 'verdict'],
}
const FIX_BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, file: { type: 'string' }, line: { type: 'number' }, excerpt: { type: 'string' }, severity: { type: 'string' }, evidence: { type: 'string' } }, required: ['index', 'file', 'excerpt', 'severity', 'evidence'] } },
    note: { type: 'string' },
  },
  required: ['items', 'note'],
}
const FIX_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingRef: { type: 'number', description: 'the fix-brief item index this decides' },
          action: { type: 'string', enum: ['fix', 'dispute', 'defer'] },
          design: { type: 'string' },
          invariant: { type: 'string' },
          testPin: { type: 'string', description: 'the test that pins this fix, or empty when none is runnable' },
          executorTier: { type: 'string', enum: ['mechanical', 'sonnet', 'opus'], description: 'mechanical = fully determined once named; sonnet = a designed LOW-risk change; opus = a HIGH-risk file or a judgment call the executor still has to make' },
        },
        required: ['findingRef', 'action', 'design', 'invariant', 'testPin', 'executorTier'],
      },
    },
    deferred: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['fixes', 'deferred', 'note'],
}
const EXECUTE_SCHEMA = {
  type: 'object',
  properties: {
    findingRef: { type: 'number' },
    status: { type: 'string', enum: ['done', 'blocked'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    gate: { type: 'object', properties: { command: { type: 'string' }, pass: { type: 'boolean' }, summary: { type: 'string' } } },
    note: { type: 'string' },
  },
  required: ['findingRef', 'status', 'filesChanged', 'note'],
}
const CHECKPOINT_SCHEMA = {
  type: 'object',
  properties: { written: { type: 'boolean' }, path: { type: 'string' }, note: { type: 'string' } },
  required: ['written', 'path', 'note'],
}
const RESULT_WRITE_SCHEMA = {
  type: 'object',
  properties: { written: { type: 'boolean' }, path: { type: 'string' }, endedAt: { type: 'string' }, note: { type: 'string' } },
  required: ['written', 'path', 'endedAt', 'note'],
}

// ---------- phase bookkeeping (mirrors pipeline.js's phaseReport shape) -----
const phaseReport = []
const checkpoints = []
// Pre-seeded 0 for every real phase (mirrors pipeline.js) so an unbumped
// phase reads as a confirmed 0, never an absent key the ledger has to guess
// at.
const confirmedByPhase = {}
for (const t of PHASE_ORDER) confirmedByPhase[t] = 0
let findings = [] // remaining open findings, across the whole run
let ckSeq = 0
// F5: true once any Fable brief this run needed truncation at the cap --
// never reset, exactly like pipeline.js's own fixPlanBriefTruncated, so a
// later round's phase row still reads true once it has ever happened.
let fixPlanBriefTruncated = false

// F9: {phase, ran, agents, rawFindings, tokens: null, estUsd: null, model,
// effort, note} -- the same row shape pipeline.js's buildPhaseRow emits, so
// pipeline-ledger.mjs's buildRow() needs no light-loop-specific branch.
// tokens/estUsd stay null (an unknown reading is never reported as free);
// model/effort are the phase's static labels above. Returns the pushed row
// so a caller (F5) can attach a one-off flag like briefTruncated after the
// fact.
function recordPhase(alias, ran, agents, note, rawFindings) {
  const row = { phase: alias, ran, agents, rawFindings: rawFindings || 0, tokens: null, estUsd: null, model: PHASE_MODELS[alias] || null, effort: PHASE_EFFORTS[alias] || null, note: note || '' }
  phaseReport.push(row)
  return row
}
function bumpConfirmed(alias, n) {
  if (!n) return
  confirmedByPhase[alias] = (confirmedByPhase[alias] || 0) + n
}
// C1-style checkpoint: one Haiku@low agent per phase, idempotency key
// runId:phase:attempt, writes <runDir>/phases/NN-<alias>.json verbatim.
async function checkpoint(alias, payload) {
  ckSeq += 1
  const seq = String(ckSeq).padStart(2, '0')
  const path = `${runDir}/phases/${seq}-${alias.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.json`
  const idempotencyKey = `${runId}:${alias}:${seq}`
  const body = { ...payload, idempotencyKey }
  const prompt = [
    `You are the CHECKPOINT WRITER -- mechanical. The only thing you may change on disk is the one file named below.`,
    `1. Run \`mkdir -p "${runDir}/phases"\`.`,
    `2. If "${path}" already exists AND its idempotencyKey field already equals "${idempotencyKey}", do nothing further and report written=true, note="already written (idempotent)".`,
    `3. Otherwise write EXACTLY this JSON, verbatim, to "${path}" (create or overwrite):`,
    JSON.stringify(body),
    `4. Touch NOTHING else -- no other file, no commit, no git command.`,
    `Report written (true only if the file is now on disk with this content), path (absolute), and note.`,
  ].join('\n')
  let result = null
  try {
    result = await askAgent(prompt, { label: `checkpoint:${alias}`, phase: alias, model: MODEL.haiku, effort: 'low', schema: CHECKPOINT_SCHEMA })
  } catch (e) { result = null }
  checkpoints.push({ seq: ckSeq, phase: alias, path, written: !!(result && result.written), note: (result && result.note) || (result ? '' : 'checkpoint agent died or returned nothing -- non-fatal, run continues') })
}
// A null/declined agent return is itself a finding -- never silently "clean".
// Carries `phase` (F4) so confirmedByPhase can credit whichever lens/phase
// actually produced it, exactly as pipeline.js's own findings carry `.phase`.
function deadAgentFinding(phase, label) {
  return { severity: 'major', file: briefPath, phase, summary: `${label} agent returned nothing`, evidence: `agent() resolved null for label "${label}" in phase "${phase}" -- a declined or dead subagent, not a pass`, scenario: `re-running "${label}" is required before this phase can be trusted as clean` }
}

const runId = typeof _args.runId === 'string' && _args.runId ? _args.runId : `wf_${String(runDir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'run'}`

// ═══════════ Phase 0: Preflight (alias Baseline) ═══════════════════════════
function preflightPrompt(attempt) {
  return [
    `You are the PREFLIGHT gate for a bounded light-loop run, attempt ${attempt} of 3.`,
    `1. Check host contention: count running node/npm/docker processes and current CPU load using whatever command this OS supports (Windows: \`tasklist\`; POSIX: \`ps\`/\`uptime\`). Count ONLY build-tool work: processes whose command line names jest, tsc, next, turbo, vitest, playwright, webpack, esbuild, docker, matlab, or npm run / npm test. Claude Code sessions and their MCP servers are node processes too (about 8 per open session) and do NOT count -- inspect command lines (Windows: PowerShell Get-CimInstance Win32_Process, or wmic process get commandline), never a bare tasklist count. Treat the host as contended only if more than 6 such build-tool processes are running, or CPU load looks pegged (>90% sustained across two samples a few seconds apart). Use judgment -- this is a heuristic, not a hard threshold from a config file.`,
    `2. Run \`git status --short\` -- treeClean is true only if it prints nothing.`,
    `3. Write "${runDir}/RESUME.md" (create the directory first if needed) with: the brief path "${briefPath}", this runId "${runId}", startedAt "${startedAt || 'unknown'}", and a one-line "mode: light-loop, scale: unknown-until-Ground". Set resumeWritten=true only if the write actually succeeded.`,
    `Report contended, treeClean, resumeWritten, and note (one line).`,
  ].join('\n')
}
// No checkpoint call here: on contention this returns straight to the abort
// path, which must make ZERO further agent calls of any kind, checkpoints
// included. The successful path's checkpoint happens once, jointly with
// Ground's, in the main flow below -- Preflight and Ground share one
// PHASE_ORDER row ('Baseline'), so they share one checkpoint file too.
async function runPreflight() {
  let result = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    result = await askAgent(preflightPrompt(attempt), { label: 'preflight', phase: 'Baseline', model: MODEL.haiku, effort: 'low', schema: PREFLIGHT_SCHEMA })
    if (result && !result.contended) break
  }
  return result
}

// ═══════════ Phase 1: Ground (alias Baseline) ══════════════════════════════
function groundPrompt() {
  return [
    `You are the GROUND-TRUTH checker -- mechanical, read-only.`,
    `Read the brief at "${briefPath}" in full. For every file, script, and git sha it names, confirm it actually exists (a file via a direct read or \`ls\`, a sha via \`git cat-file -e\` or \`git show --stat\`). Also extract the brief's own package list -- each package's id, title, one-line brief, file list, and risk (HIGH if it touches money/auth/tenancy/schema/PII, else LOW; default LOW when the brief does not say).`,
    `Report ok (true only if every named file/script/sha exists), missing (the ones that do not), packages (echoed back exactly as the brief states them), and note.`,
  ].join('\n')
}
async function runGround() {
  return askAgent(groundPrompt(), { label: 'ground', phase: 'Baseline', model: MODEL.haiku, effort: 'low', schema: GROUND_SCHEMA })
}

// ═══════════ Phase 2: Build (alias Implement) ══════════════════════════════
function buildPrompt(pkg) {
  return [
    `You are the BUILDER for ONE package. Implement it completely; do not improvise beyond the brief -- a departure is a deviation, report it, never silently substitute your own design.`,
    `Package "${pkg.id}: ${pkg.title}". Brief: ${pkg.brief}`,
    `Files this package owns: ${JSON.stringify(pkg.files || [])}. Touch only these unless the brief names more.`,
    `Run whatever scoped gates this repo has for these files (typecheck, lint, the touched suites) and report each as {command, pass, summary}.`,
    `Report packageId, filesChanged, gates, findings (anything wrong you noticed but did not fix because it is out of this package's scope), and deviations (anything you did that the brief did not ask for, with why).`,
  ].join('\n')
}
async function buildOnePackage(pkg) {
  const effort = pkg.risk === 'HIGH' ? 'high' : 'medium'
  const opts = { label: `build:${pkg.id}`, phase: 'Implement', model: MODEL.sonnet, effort, schema: BUILD_SCHEMA }
  if (wantWorktree) opts.isolation = 'worktree'
  const result = await askAgent(buildPrompt(pkg), opts)
  return result || { packageId: pkg.id, filesChanged: [], gates: [], findings: [deadAgentFinding('Implement', `build:${pkg.id}`)], deviations: [] }
}
// Single-agent default for coherent sequential work (ruling C1) -- fan out
// only when the caller declared concurrentEditors AND asked for worktree
// isolation. A shared file across packages is a brief-authoring bug the
// brief must declare via `dependsOn`, never inferred from a path prefix here.
async function runBuild(packages) {
  if (!packages.length) { recordPhase('Implement', false, 0, 'no packages in the brief'); return [] }
  let results
  if (wantWorktree && packages.length > 1) {
    const pairs = [...new Set(packages.map((p) => [MODEL.sonnet, p.risk === 'HIGH' ? 'high' : 'medium'].join('|')))].map((s) => s.split('|'))
    await warmUpWave(pairs, 'Implement')
    results = await parallel(packages.map((p) => () => buildOnePackage(p)))
    results = results.map((r, i) => r || { packageId: packages[i].id, filesChanged: [], gates: [], findings: [deadAgentFinding('Implement', `build:${packages[i].id}`)], deviations: [] })
  } else {
    results = []
    for (const p of packages) results.push(await buildOnePackage(p))
  }
  const agentsRan = results.length
  const deviationCount = results.reduce((n, r) => n + (r.deviations ? r.deviations.length : 0), 0)
  recordPhase('Implement', true, agentsRan, deviationCount ? `${deviationCount} deviation(s) reported` : '')
  await checkpoint('Implement', { step: 'build', results })
  return results
}

// ═══════════ Phase 3: Pack (alias Gate & Review, or Final pass on refresh) ═
function packPrompt(alias, buildResults) {
  return [
    `You are the PACK BUILDER -- read-only, mechanical. You write ONE file: "${runDir}/review-pack.md", capped at 40 KB.`,
    `Order matters (ruling A1): open with the brief's relevant spec excerpt and its acceptance criteria for the files in scope, taken from "${briefPath}" verbatim -- BEFORE any diff. Then the diff hunks for every file these packages changed: ${JSON.stringify((buildResults || []).flatMap((r) => r.filesChanged || []))}. Then the call sites of every export those hunks changed (grep the repo for importers/callers -- one snippet each, not the whole file). Then, if "${lessonsPath}" exists, the lesson ids relevant to these files.`,
    `If the full pack would exceed 40 KB, drop the lowest-priority section first (call sites, then lesson ids) and set truncated=true -- never silently cut the spec excerpt or the diff hunks.`,
    `Report written, path, bytes (actual file size), truncated, and note.`,
  ].join('\n')
}
async function runPack(alias, buildResults) {
  const result = await askAgent(packPrompt(alias, buildResults), { label: 'pack', phase: alias, model: MODEL.sonnet, effort: 'low', schema: PACK_SCHEMA })
  if (!result || !result.written) findings.push(deadAgentFinding(alias, 'pack'))
  return result
}

// ═══════════ Phase 4: Review (alias Gate & Review) ═════════════════════════
function reviewPrompt(lens) {
  const lensLine = lens
    ? `Your lens is ${lens.name}: ${lens.focus}. Read only through that lens -- a finding outside it belongs to the other lens.`
    : `Correctness lens: read for defects that produce a wrong output or a crash under a concrete input/state.`
  return [
    `You are a REVIEW LENS -- read-only reviewer; you make no edits and run no mutating command. You have a budget of AT MOST 12 tool calls; stop and report at 12 even if you have more to check.`,
    `Read "${runDir}/review-pack.md" (your primary evidence) plus "${lessonsPath || '(no lessons register given)'}".`,
    lensLine,
    `Refute your own finding before reporting it (state why it survives). Every finding is "plausible" until execution-verified (ruling A2) -- never mark one confirmed yourself.`,
    `Report claims (per-claim HELD/REFUTED with file:line), findings (most-severe-first), and verdict SHIP / FIX-FIRST / BLOCK.`,
  ].join('\n')
}
async function runReview() {
  const alias = 'Gate & Review'
  if (spansSkillAndRepo) {
    const lenses = [
      { name: 'engine/scripts', focus: 'the Workflow scripts and skill engine files in scope' },
      { name: 'docs/repo', focus: 'the skill docs, references, and any repo (non-engine) files in scope' },
    ]
    await warmUp(MODEL.opus, 'high', alias)
    const results = await parallel(lenses.map((lens) => () => askAgent(reviewPrompt(lens), { label: `review:${lens.name}`, phase: alias, model: MODEL.opus, effort: 'high', schema: REVIEW_SCHEMA })))
    const safe = results.map((r, i) => r || { claims: [], findings: [deadAgentFinding(alias, `review:${lenses[i].name}`)], verdict: 'BLOCK' })
    recordPhase(alias, true, safe.length, '', safe.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0))
    return safe
  }
  const result = await askAgent(reviewPrompt(null), { label: 'review:correctness', phase: alias, model: MODEL.opus, effort: 'high', schema: REVIEW_SCHEMA })
  const safeResult = result || { claims: [], findings: [deadAgentFinding(alias, 'review:correctness')], verdict: 'BLOCK' }
  recordPhase(alias, true, 1, '', (safeResult.findings || []).length)
  return [safeResult]
}

// ═══════════ Phase 5: Fix brief (alias Fix) ════════════════════════════════
function fixBriefPrompt(openFindings) {
  return [
    `You are the FIX BRIEF builder. You propose NO design -- you package findings for a decider.`,
    `Findings to package, each already numbered [#index]:`,
    openFindings.map((f, i) => `[#${i}] ${f.severity} ${f.file}${f.line ? ':' + f.line : ''} -- ${f.summary}\nevidence: ${f.evidence}\nscenario: ${f.scenario}`).join('\n\n'),
    `For each, pull the exact excerpt and its known callers (grep, do not guess) into items[]. Report items and note.`,
  ].join('\n')
}
async function runFixBrief(openFindings) {
  const alias = 'Fix'
  if (!openFindings.length) return { items: [], note: 'no findings' }
  const result = await askAgent(fixBriefPrompt(openFindings), { label: 'fix-brief', phase: alias, model: MODEL.sonnet, effort: 'low', schema: FIX_BRIEF_SCHEMA })
  if (result) {
    // F4: FIX_BRIEF_SCHEMA never asks the agent for a `phase` -- attach each
    // item's originating phase ourselves (by the same positional index
    // fixBriefPrompt numbered openFindings with) so confirmedByPhase credits
    // the lens that actually raised the finding, never the packager's alias.
    const items = (result.items || []).map((it) => ({ ...it, phase: (openFindings[it.index] || {}).phase || null }))
    return { ...result, items }
  }
  // F1: the fix-brief agent died -- openFindings must NOT vanish into
  // `{items: []}` (that reads as "nothing to fix" and silently drops every
  // open finding). Carry them forward unchanged as items, skipping only the
  // excerpt-pulling step, and surface the death itself as one more item so it
  // is never a silent clean pass either.
  const carriedItems = openFindings.map((f, i) => ({ index: i, file: f.file, line: f.line, excerpt: f.summary, severity: f.severity, evidence: f.evidence, phase: f.phase || null }))
  const dead = deadAgentFinding(alias, 'fix-brief')
  carriedItems.push({ index: carriedItems.length, file: dead.file, excerpt: dead.summary, severity: dead.severity, evidence: dead.evidence, phase: dead.phase })
  return { items: carriedItems, note: 'fix-brief agent returned nothing -- openFindings carried forward unchanged' }
}

// ═══════════ Phase 6: Fix plan (alias Fix) — Fable rules, zero repo access ═
function fixPlanPrompt(brief) {
  return [
    `You are the FIX PLANNER. You read NOTHING from the repo -- only the brief text below. For each item, decide fix / dispute / defer; for every "fix" write the design (the exact invariant and edit), the test that pins it (testPin -- empty string if none is runnable), and the executor tier: "mechanical" (fully determined once named), "sonnet" (a designed LOW-risk change), or "opus" (a HIGH-risk file, or a judgment call the executor still has to make).`,
    `Findings to decide:`,
    (brief.items || []).map((it) => `[#${it.index}] ${it.severity} ${it.file}${it.line ? ':' + it.line : ''}\nexcerpt: ${it.excerpt}\nevidence: ${it.evidence}`).join('\n\n'),
    `Report fixes (one decision per item you act on), deferred (open questions this run cannot answer), and note.`,
  ].join('\n')
}
async function runFixPlan(brief) {
  const alias = 'Fix'
  if (!brief.items || !brief.items.length) return { fixes: [], deferred: [], note: 'nothing to plan' }
  // Inline when the session itself IS Fable (no agent hop needed) is a
  // caller-side decision this script cannot make -- it always spawns the
  // planner agent; a Fable-session caller can instead rule inline and pass
  // the ruling in as args.fixPlanOverride to skip this call entirely.
  if (_args.fixPlanOverride) return _args.fixPlanOverride
  // F5: cap the brief once, reuse the SAME (possibly truncated) text on the
  // Opus fallback retry below -- it is the same content whichever model
  // reads it (mirrors pipeline.js's capFableBrief() call sites exactly).
  const capped = capFableBrief(fixPlanPrompt(brief))
  if (capped.truncated) fixPlanBriefTruncated = true
  let result = await askAgent(capped.text, { label: 'fix-plan', phase: alias, model: MODEL.fable, effort: 'high', schema: FIX_PLAN_SCHEMA })
  if (!result) {
    // Fable's safety classifiers can decline outright -- retry once on Opus
    // at the effort the read deserves (FABLE-PROMPTING.md "Refusals and
    // fallbacks"). This Opus call stays EXEMPT from the F8 tool-call cap: it
    // decides from the brief text alone, zero repo access.
    result = await askAgent(capped.text, { label: 'fix-plan:fallback', phase: alias, model: MODEL.opus, effort: 'xhigh', schema: FIX_PLAN_SCHEMA })
  }
  return result || { fixes: [], deferred: (brief.items || []).map((it) => `#${it.index}: planner declined on both Fable and the Opus fallback`), note: 'fix planner produced nothing' }
}

// ═══════════ Phase 7: Execute (alias Fix) ══════════════════════════════════
function executePrompt(fix, item) {
  return [
    `You are a FIX EXECUTOR. Implement EXACTLY this design -- never improvise beyond it. If the design does not fit the code as you find it, stop and report status=blocked with why (that becomes a designMismatch for the next planning round, never your own substitute fix).`,
    `Finding: ${item ? `${item.severity} ${item.file}${item.line ? ':' + item.line : ''} -- ${item.excerpt}` : `#${fix.findingRef}`}`,
    `Design: ${fix.design}`,
    `Invariant: ${fix.invariant}`,
    fix.testPin ? `Pin this with the test: ${fix.testPin} -- it must go from failing to passing.` : `No runnable test pins this fix; report your gate command and result anyway if one applies.`,
    `Report findingRef=${fix.findingRef}, status, filesChanged, gate ({command, pass, summary}) if you ran one, and note.`,
  ].join('\n')
}
function executorModelEffort(tier) {
  if (tier === 'opus') return [MODEL.opus, 'high']
  if (tier === 'sonnet') return [MODEL.sonnet, 'medium']
  return [MODEL.sonnet, 'low']
}
async function executeOneFix(fix, item) {
  const [model, effort] = executorModelEffort(fix.executorTier)
  const opts = { label: `execute:${fix.findingRef}`, phase: 'Fix', model, effort, schema: EXECUTE_SCHEMA }
  if (wantWorktree) opts.isolation = 'worktree'
  // F8: an Opus-tier executor opens source files freely -- it gets the same
  // 12-tool-call budget clause the re-check reader carries. Mechanical/sonnet
  // tiers stay uncapped (their designs are already fully determined).
  const promptText = fix.executorTier === 'opus' ? withOpusCap(executePrompt(fix, item)) : executePrompt(fix, item)
  const result = await askAgent(promptText, opts)
  return result || { findingRef: fix.findingRef, status: 'blocked', filesChanged: [], note: 'executor agent returned nothing' }
}
async function runExecute(plan, briefItems) {
  const alias = 'Fix'
  const toFix = (plan.fixes || []).filter((f) => f.action === 'fix')
  if (!toFix.length) { recordPhase(alias, false, 0, 'no fixes to execute this round'); return [] }
  const itemByIndex = new Map((briefItems || []).map((it) => [it.index, it]))
  let results
  if (wantWorktree && toFix.length > 1) {
    const pairs = [...new Set(toFix.map((f) => executorModelEffort(f.executorTier).join('|')))].map((s) => s.split('|'))
    await warmUpWave(pairs, alias)
    results = await parallel(toFix.map((f) => () => executeOneFix(f, itemByIndex.get(f.findingRef))))
    results = results.map((r, i) => r || { findingRef: toFix[i].findingRef, status: 'blocked', filesChanged: [], note: 'executor agent returned nothing' })
  } else {
    results = []
    for (const f of toFix) results.push(await executeOneFix(f, itemByIndex.get(f.findingRef)))
  }
  // Fix is a CONSUMING phase (it acts on findings other phases authored, it
  // never authors new ones) -- rawFindings is always 0 here, matching
  // pipeline-ledger.mjs's CONSUMING_PHASES treatment of 'Fix'.
  const row = recordPhase(alias, true, results.length, '', 0)
  if (fixPlanBriefTruncated) row.briefTruncated = true
  await checkpoint('Fix', { step: 'execute', plan, results })
  return results
}

// ═══════════ Phase 8: Re-check (alias Final pass) ══════════════════════════
function recheckPrompt() {
  // F8: the Opus re-check reader opens source files freely, so it carries the
  // same 12-tool-call budget clause the review lenses already have inline.
  return withOpusCap([
    `You are the RE-CHECK reviewer -- read-only. Read "${runDir}/review-pack.md" (freshly refreshed over ONLY the fixes just applied this round -- no new lenses, no re-reading files outside this round's changes).`,
    `Confirm each applied design actually landed and holds; report any NEW findings only if the fix itself introduced them.`,
    `Report claims, findings, and verdict SHIP / FIX-FIRST / BLOCK.`,
  ].join('\n'))
}
async function runRecheck(executeResults) {
  const alias = 'Final pass'
  await runPack(alias, executeResults.map((r) => ({ filesChanged: r.filesChanged || [] })))
  const result = await askAgent(recheckPrompt(), { label: 'recheck', phase: alias, model: MODEL.opus, effort: 'high', schema: REVIEW_SCHEMA })
  const safeResult = result || { claims: [], findings: [deadAgentFinding(alias, 'recheck')], verdict: 'BLOCK' }
  // Final pass is an AUTHORING phase (pipeline-ledger.mjs AUTHORING_PHASES) --
  // its rawFindings signal is this round's fresh findings count.
  recordPhase(alias, true, 2, '', (safeResult.findings || []).length) // the pack-refresh (Sonnet) + this one Opus recheck
  await checkpoint(alias, { step: 'recheck', result: safeResult })
  return safeResult
}

// ═══════════ Phase 9: Result (alias Final pass) ════════════════════════════
async function runResult(payload) {
  const alias = 'Final pass'
  const path = `${runDir}/result.json`
  const prompt = [
    `You are the RESULT WRITER -- mechanical, the last step of this run.`,
    `1. Get the current UTC ISO timestamp (e.g. \`node -e "console.log(new Date().toISOString())"\`, or the OS equivalent) -- that is endedAt.`,
    `2. Write EXACTLY this JSON to "${path}" (create or overwrite), with your real endedAt merged in as the top-level "endedAt" field -- change nothing else:`,
    JSON.stringify(payload),
    `3. Touch NOTHING else.`,
    `Report written, path, endedAt (the value you actually wrote), and note.`,
  ].join('\n')
  const result = await askAgent(prompt, { label: 'result', phase: alias, model: MODEL.haiku, effort: 'low', schema: RESULT_WRITE_SCHEMA })
  return result
}

// ═══════════ main flow ══════════════════════════════════════════════════════
// Builds the terminal payload and closes the run out via the Result agent --
// used by both the ground-check early exit and the normal end of the run, so
// every path that returns from here is equally closeable by closeout.mjs.
async function closeOut(rounds, clean) {
  // F3: 'Final pass' always fires here -- Result (phase 9) and, when a fix
  // round ran, the round's own recheck are both folded into this alias, and
  // every terminating path (ground failure, clean end, cap-out) reaches
  // closeOut exactly once (the host-contention abort never does).
  phase('Final pass')
  // F2: fixRounds is the field pipeline-ledger.mjs buildRow() and
  // closeout.mjs both actually read (`rounds` is kept too, for any caller
  // still reading the old field name -- never a breaking rename).
  const payload = { mode: 'light-loop', scale: 'small', runId, startedAt, endedAt: null, rounds, fixRounds: rounds, clean, remainingFindings: findings, confirmedByPhase, phaseReport, checkpoints }
  // The "+1" checkpoint: one more durable copy after every per-phase
  // checkpoint above, so `checkpoints.length === ranPhases + 1` always --
  // pipeline.js's own P1 invariant, carried over unchanged.
  await checkpoint('Final pass', { step: 'final', payload })
  log('light-loop: writing result.json')
  await runResult(payload)
  return payload
}

log('light-loop: preflight')
phase('Baseline')
const preflight = await runPreflight()
if (!preflight || preflight.contended) {
  // Host contention after 3 retries -- early return BEFORE any further agent
  // call of ANY kind, checkpoints included (ruling: "before any further
  // call"). No Ground, no Build, no checkpoint, no result write.
  return { aborted: 'host-contention', phaseReport: [] }
}

log('light-loop: grounding the brief')
const ground = await runGround()
// Preflight and Ground share one PHASE_ORDER row ('Baseline') -- one
// checkpoint and one phaseReport entry for both, win or fail.
await checkpoint('Baseline', { preflight, ground })
if (!ground || !ground.ok) {
  recordPhase('Baseline', true, 2, ground ? `missing: ${(ground.missing || []).join(', ')}` : 'ground agent returned nothing', 1)
  findings.push(ground ? { severity: 'blocker', file: briefPath, phase: 'Baseline', summary: 'brief names files/scripts/shas that do not exist', evidence: (ground.missing || []).join(', '), scenario: 'Build would implement against a brief citing non-existent inputs' } : deadAgentFinding('Baseline', 'ground'))
  return closeOut(0, false)
}
recordPhase('Baseline', true, 2, preflight.treeClean ? '' : 'tree not clean at preflight', 0)
const packages = ground.packages || []

log('light-loop: build')
phase('Implement')
const buildResults = await runBuild(packages)
// F4: tag every build finding with its originating phase (unless the
// builder/dead-agent path already stamped one) so confirmedByPhase can
// credit it correctly if a later fix round resolves it.
findings = findings.concat(buildResults.flatMap((r) => (r.findings || []).map((f) => ({ ...f, phase: f.phase || 'Implement' }))))

log('light-loop: pack + review')
phase('Gate & Review')
await runPack('Gate & Review', buildResults)
const reviewResults = await runReview()
await checkpoint('Gate & Review', { reviewResults })
findings = findings.concat(reviewResults.flatMap((r) => (r.findings || []).map((f) => ({ ...f, phase: f.phase || 'Gate & Review' }))))
const anyBlock = reviewResults.some((r) => r.verdict === 'BLOCK')

let rounds = 0
let clean = false
// F7: a BLOCK review verdict is a hard stop INTO the fix pipeline, never a
// bypass of it -- whenever there are findings to act on, Fix runs (rounds
// still capped at maxFixRounds exactly as any other dirty run earns).
if (findings.length) {
  phase('Fix')
  while (findings.length && rounds < maxFixRounds) {
    rounds += 1
    log(`light-loop: fix round ${rounds}/${maxFixRounds}`)
    const brief = await runFixBrief(findings)
    const plan = await runFixPlan(brief)
    const disputed = new Set((plan.fixes || []).filter((f) => f.action === 'dispute').map((f) => f.findingRef))
    const deferredRefs = new Set((plan.fixes || []).filter((f) => f.action === 'defer').map((f) => f.findingRef))
    const itemByIndex = new Map((brief.items || []).map((it) => [it.index, it]))
    const executeResults = await runExecute(plan, brief.items)
    const doneRefs = new Set(executeResults.filter((r) => r.status === 'done').map((r) => r.findingRef))
    const recheck = await runRecheck(executeResults)
    for (const ref of doneRefs) {
      const exec = executeResults.find((r) => r.findingRef === ref)
      const testedGreen = !!(exec && exec.gate && exec.gate.pass)
      // F4: credit the phase that ORIGINALLY raised this finding (Implement,
      // Gate & Review, a prior round's Final pass, ...) -- never a blanket
      // 'Final pass', which mirrors pipeline.js's own confirmedByPhase
      // keying off each finding's `.phase`, not off where the fix executed.
      const originPhase = (itemByIndex.get(ref) || {}).phase || 'Fix'
      bumpConfirmed(originPhase, testedGreen ? 1 : 0)
    }
    // Findings still open next round: not disputed-away, not resolved 'done',
    // plus anything the re-check itself surfaced.
    const stillOpen = brief.items
      .filter((it) => !disputed.has(it.index) && !doneRefs.has(it.index))
      .map((it) => ({ severity: it.severity, file: it.file, line: it.line, summary: it.excerpt, evidence: it.evidence, phase: it.phase || null, scenario: deferredRefs.has(it.index) ? 'deferred to the owner' : 'fix round did not resolve this' }))
    findings = stillOpen.concat((recheck.findings || []).map((f) => ({ ...f, phase: f.phase || 'Final pass' })))
    clean = findings.length === 0 && recheck.verdict === 'SHIP'
    if (clean) break
  }
} else {
  // Nothing machine-readable to fix -- still not clean if the review
  // outright BLOCKed with no findings[] entry (e.g. a reader that hit its
  // own tool-call cap and reported BLOCK with nothing to package).
  clean = !anyBlock
}

return closeOut(rounds, clean)
