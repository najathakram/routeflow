export const meta = {
  name: 'dev-pipeline',
  description: 'Task-loop delivery engine: per-task test authoring, a red gate, implementation, and one adversarial review, run in dependsOn-ordered parallel waves, with Haiku running every mechanical gate and Fable ruling on HIGH-risk reviews and fixes.',
  phases: [
    { title: 'Baseline' },
    { title: 'Author tests' },
    { title: 'Red gate' },
    { title: 'Implement' },
    { title: 'Gate & Review' },
    { title: 'Verify' },
    { title: 'UI verify' },
    { title: 'Mutation probe' },
    { title: 'Fix' },
    { title: 'Final pass' },
  ],
}

// pipeline.js -- task-loop engine rebuild.
// docs/superpowers/plans/2026-09-12-task-loop-rebuild.md (S1-S6, Part A tasks
// A1-A17). Old engine preserved at pipeline.js.bak-2026-09-12. This file grows
// task-by-task; through A1-A3 it is meta + config + plan validation only, and
// every valid plan still reports itself unimplemented so the dry-run harness
// has something real to observe RED against (scenario A) until A4+ lands.

// ---- CONFIG -- every tuning knob lives here ----
const CFG = {
  // MODELS -- full ids, never bare aliases: an alias resolves to whatever the
  // harness currently maps it to (a bare 'sonnet' can land on a different
  // Sonnet build than the one this run was priced and routed for).
  models: {
    fable: 'claude-fable-5-1',
    sonnet: 'claude-sonnet-5',
    haiku: 'claude-haiku-4-5',
    // Owner ruling 2026-09-13 (supersedes 2026-09-10 "Fable replaces Opus everywhere"):
    // implementation — writing code to a file — is NEVER Fable; it is Sonnet.
    // What to write (design, root cause, fix design) is Opus. Review on HIGH-risk
    // is Opus. Fable keeps only planning (S1–S5) and the final-pass read.
    opus: 'claude-opus-5',
    fallbackModel: 'claude-opus-5',
  },
  // Effort per role. 'implement' is the default implementer tier; a task with
  // risk 'HIGH' keeps Sonnet but escalates to 'implementHigh' effort (ruling 2026-09-13).
  effort: {
    baseline: 'low',
    testAuthor: 'medium',
    redCheck: 'low',
    implement: 'medium',
    implementHigh: 'high',
    pack: 'low',
    review: 'high',
    fixExec: 'medium',
    fixDesign: 'high',
    checkpoint: 'low',
    uiDrive: 'medium',
    // A10/A11/A12/A13 roles (bugfix task types, ui-verify, sibling sweep,
    // Final pass): root-cause/sibling-judge/final-read are judgment calls
    // (high, on Sonnet or Fable per isHighRisk); probe/checksum are Haiku
    // mechanics (checksum stays 'low' like every other script-runner call;
    // probe gets 'medium' -- a revert-probe backs up, reverts, runs one
    // test and restores, more procedure than a one-line script run).
    rootCause: 'high',
    probe: 'medium',
    checksum: 'low',
    siblingGrep: 'low',
    siblingJudge: 'high',
    finalRead: 'high',
  },
  caps: {
    toolCalls: 12, // withToolCap(): every Fable AND Opus agent call is capped at this many tool calls (judgment over a pack, never exploration).
    fableBriefBytes: 8192,
    packBytes: 40960,
    briefBytes: 1536, // per-task args.tasks[].brief cap (Baseline enforces this).
    planBytes: {
      small: { build: 12288, test: 8192 },
      major: { build: 32768, test: 24576 },
    },
  },
  maxFixRounds: 4,
  // PROFILES (S6): 'lean' = superpowers parity (no separate test author, no
  // probes, reviewer always Sonnet, Baseline skips the final-command check);
  // 'standard' = the full S1-S5 design. args.profile overrides the default
  // (scale:'small' + no HIGH-risk task/manifest file -> 'lean', else 'standard').
  profiles: {
    lean: { separateTestAuthor: false, baselineFinal: false, probes: false, reviewerAlwaysSonnet: true },
    standard: { separateTestAuthor: true, baselineFinal: true, probes: true, reviewerAlwaysSonnet: false },
  },
  // List prices per MTok, used ONLY to estimate what each phase cost
  // (phaseReport[].estUsd). Refresh from the claude-api skill's "Current
  // Models" table and bump asOf -- an estimate at stale prices is labelled.
  // T2 cost-plan (2026-09-14): four classes, not two -- a run with heavy
  // cache reuse (this engine's own askAgent warmups included) was previously
  // priced as if every counted token were a fresh output token, which is why
  // the run's own estimate under-reported true cost roughly 4.3x against the
  // ledger's real usage-based numbers. estUsd() below still falls back to
  // the old single-rate (output) math when a caller can only supply a raw
  // scalar token count with no class breakdown (today's only real source,
  // budget.spent() -- see A14) -- flagged approx in that case.
  prices: {
    asOf: '2026-06-24',
    'claude-fable-5-1': { input: 10, output: 50, cacheWrite1h: 20, cacheRead: 0.25 },
    'claude-opus-5': { input: 5, output: 25, cacheWrite1h: 10, cacheRead: 0.50 },
    'claude-sonnet-5': { input: 2, output: 10, cacheWrite1h: 4, cacheRead: 0.20 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheWrite1h: 2, cacheRead: 0.10 },
  },
  // C1-style checkpoints (A13): a Haiku agent writes a durable phase card,
  // fire-and-forget, after each task/phase completes.
  checkpoint: { enabled: true, maxSummaryKb: 32, payloadFindingChars: 200 },
  maxConcurrent: 16,
}

// ---------- A3: task-graph validation ----------
// Every args.tasks[].type the engine recognizes. Anything else is a
// (build-plan) blocker -- an unrecognized type would otherwise silently take
// the 'feature' path and skip whatever gating its real type needed.
const TASK_TYPES = ['feature', 'root-cause', 'repro-test', 'fix', 'revert-probe', 'docs', 'ui-verify']

// Fix round 1 (task review, finding 3): match the shape the rest of the
// engine's findings use (pipeline.js.bak-2026-09-12 @741-746, @3064-3071) --
// `phase` (consumed by A13 checkpoint payloads and phaseReport), no `line`/
// `source` (no consumer plans to read either).
function toBuildPlanBlocker(message) {
  return { file: '(build-plan)', severity: 'blocker', phase: 'Baseline', summary: message, detail: message }
}

// Normalize path spellings so 'src\\a.ts', './src/a.ts', and 'src/a.ts' are
// one key (fix round 1, finding 1; lifted from pipeline.js.bak-2026-09-12
// @2080). Without this the shared-file rule below is defeated by spelling
// alone: two tasks that touch the SAME file under different-looking paths
// were never compared as equal.
function normPath(p) {
  return (p || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

// The set of task ids reachable by walking dependsOn edges from `id`,
// transitively (NOT including `id` itself). Dedupe-by-seen makes this safe
// against a dependsOn cycle: a cycle just stops contributing new ids once
// every member has been visited once. NOTE: in a cycle this can include
// `id` itself, and can make dependsPathExists() below report two cyclic
// tasks as "ordered" -- detectGraphIssues() catches that case directly with
// its own dedicated cycle blocker, so this quirk is never the only guard.
function ancestorIds(id, byId) {
  const seen = new Set()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()
    const t = byId.get(cur)
    if (!t) continue
    for (const dep of t.dependsOn || []) {
      if (seen.has(dep)) continue
      seen.add(dep)
      stack.push(dep)
    }
  }
  return seen
}

// A10: returns the actual ancestor task OBJECTS of a given type (not just a
// boolean) -- fixGateStage needs the real root-cause task(s) to look up their
// results by id, not merely proof that one exists (validateTasks' own job).
function ancestorsOfType(id, byId, type) {
  const out = []
  for (const aid of ancestorIds(id, byId)) {
    const t = byId.get(aid)
    if (t && t.type === type) out.push(t)
  }
  return out
}
function hasAncestorOfType(id, byId, type) {
  return ancestorsOfType(id, byId, type).length > 0
}

// True when either task is a (transitive) dependsOn ancestor of the other --
// i.e. the plan already orders them, so scheduling them into separate waves
// (A7's buildWaves) is a safe, INTENDED serialization rather than a plan gap.
function dependsPathExists(aId, bId, byId) {
  return ancestorIds(aId, byId).has(bId) || ancestorIds(bId, byId).has(aId)
}

// Fix round 1 (task review, finding 2): walks each task's dependsOn edges
// (buildWaves-style DFS, pipeline.js.bak-2026-09-12 @2851-2907) to surface
// the three graph defects that OLD engine's buildWaves used to just silently
// drop the ordering constraint for: an unknown dependsOn id, a self-edge,
// and a cycle. Any of these makes the declared ordering constraint vanish --
// exactly the failure buildWaves' own issues[] (@2862-2875) existed to
// surface there; here it is a hard (build-plan) blocker instead, since no
// wave scheduler runs yet to fall back on. A cycle is reported once, from
// whichever side's DFS reaches the other side while it is still on the
// stack.
function detectGraphIssues(tasks, byId) {
  const findings = []
  const state = {} // id -> 1 = on the stack (in progress), 2 = done
  function visit(t) {
    if (state[t.id] === 2) return
    if (state[t.id] === 1) return
    state[t.id] = 1
    for (const dep of t.dependsOn || []) {
      const d = byId.get(dep)
      if (!d) {
        findings.push(toBuildPlanBlocker(`Task ${t.id} declares dependsOn "${dep}", which matches no task id -- that ordering constraint was DROPPED.`))
        continue
      }
      if (d === t) {
        findings.push(toBuildPlanBlocker(`Task ${t.id} declares dependsOn on itself -- ignored.`))
        continue
      }
      if (state[d.id] === 1) {
        findings.push(toBuildPlanBlocker(`Circular dependsOn between ${t.id} and ${d.id} -- the cycle cannot be ordered.`))
        continue
      }
      visit(d)
    }
    state[t.id] = 2
  }
  for (const t of tasks) visit(t)
  return findings
}

// Runs BEFORE any agent() call. Returns a list of (build-plan) blockers for a
// structurally invalid plan:
//  - a task id declared more than once (fix round 1: duplicate ids collapse
//    silently in a Map, so every other check below would only ever see the
//    LAST task with that id)
//  - a task whose type is not one of TASK_TYPES
//  - an unknown dependsOn id, a dependsOn self-edge, or a dependsOn cycle
//    (fix round 1, finding 2)
//  - a `fix` task with no `root-cause` AND no `repro-test` ancestor via
//    dependsOn (either missing is enough to block -- a fix must be able to
//    point at a confirmed cause and a test that proves the bug's own wrong
//    value)
//  - a `revert-probe` task with no `fix` ancestor via dependsOn
//  - two tasks that both touch the same file (compared via normPath, fix
//    round 1 finding 1) with no dependsOn path between them in either
//    direction -- buildWaves (A7) would still serialize them safely, but an
//    unordered shared-file edit is a plan gap worth surfacing before any
//    agent starts work on it
function validateTasks(tasks) {
  const list = tasks || []
  const findings = []
  const byId = new Map()
  for (const t of list) byId.set(t.id, t)

  const seenIds = new Set()
  for (const t of list) {
    if (seenIds.has(t.id)) {
      findings.push(toBuildPlanBlocker(`Task id "${t.id}" is declared more than once -- task ids must be unique.`))
    }
    seenIds.add(t.id)
  }

  for (const t of list) {
    if (!TASK_TYPES.includes(t.type)) {
      findings.push(toBuildPlanBlocker(`Task ${t.id} declares type "${t.type}", which is not one of ${TASK_TYPES.join('|')}.`))
    }
  }

  findings.push(...detectGraphIssues(list, byId))

  for (const t of list) {
    if (t.type === 'fix') {
      const hasRootCause = hasAncestorOfType(t.id, byId, 'root-cause')
      const hasReproTest = hasAncestorOfType(t.id, byId, 'repro-test')
      if (!hasRootCause || !hasReproTest) {
        const missing = [!hasRootCause ? '"root-cause"' : null, !hasReproTest ? '"repro-test"' : null].filter(Boolean).join(' and ')
        findings.push(toBuildPlanBlocker(`Task ${t.id} is type "fix" but has no ${missing} task among its dependsOn ancestors -- a fix must depend (directly or transitively) on both.`))
      }
    }
    if (t.type === 'revert-probe' && !hasAncestorOfType(t.id, byId, 'fix')) {
      findings.push(toBuildPlanBlocker(`Task ${t.id} is type "revert-probe" but has no "fix" task among its dependsOn ancestors.`))
    }
  }

  // E5 (2026-09-15, first real launch): a path listed in BOTH a task's `files`
  // and its `tests` is a plan contradiction -- the test-author scope guard
  // (enforceTestAuthorScope) reverts any author edit to a `files` path, so a
  // spec declared on both sides would be wiped the moment the author writes it.
  // "Spec-is-the-fix" tasks (the defect is the spec's own assertion) declare
  // `files: []` and `tests: [spec]` instead.
  for (const t of list) {
    const testSet = new Set((t.tests || []).map(normPath))
    const both = (t.files || []).filter((f) => testSet.has(normPath(f)))
    if (both.length) {
      findings.push(toBuildPlanBlocker(`Task ${t.id} lists ${both.join(', ')} in BOTH files and tests -- a test path may appear only in tests (use files: [] when the fix lives in the spec itself).`))
    }
  }

  // Fix round 1 (finding 2): shared-file detection was `files`-only -- two
  // tasks that both extend the same TEST file, with no dependsOn ordering
  // between them, slipped through unblocked. Overlap over
  // `[...files, ...tests]` on BOTH sides now.
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      const aOwned = [...(a.files || []), ...(a.tests || [])]
      const bPaths = new Set([...(b.files || []), ...(b.tests || [])].map(normPath))
      const shared = aOwned.filter((f) => bPaths.has(normPath(f)))
      if (shared.length && !dependsPathExists(a.id, b.id, byId)) {
        findings.push(toBuildPlanBlocker(`Tasks ${a.id} and ${b.id} both touch ${shared.join(', ')} but neither depends on the other -- add a dependsOn edge (either direction) or split the file between them.`))
      }
    }
  }

  return findings
}

// ---------- args ----------
// The Workflow runner may deliver `args` as a JSON string (scriptPath mode) or
// as an object -- normalize so destructuring works either way.
const _args = typeof args === 'string' ? JSON.parse(args) : (args || {})
const {
  tasks = [],
  verifyCommands = {},
  scale = 'small',
  mode = 'feature',
  runDir = '',
  lessonsPath = '',
  startedAt = null,
  workdir = '',
  // Fix 1 (real smoke-run finding): the 4 helper-script invocations
  // (task-brief.mjs, review-pack.mjs x2, fix-brief.mjs) are bare relative
  // paths that only resolve when the invoking agent's cwd happens to be
  // dev-pipeline's own directory -- never true for a real run, since every
  // agent is told (via REPO_NOTE) to cd into `workdir`, the TARGET repo,
  // first. This sandboxed, ASCII-only source has no os.homedir()/
  // process.env to derive its own scripts directory, so the launcher MUST
  // supply the real, absolute path to it here.
  scriptsDir = '',
} = _args

// A3: validate the task graph BEFORE any agent() call -- a structurally
// invalid plan (unknown type, a fix/revert-probe missing its required
// ancestor, two tasks sharing a file with no ordering between them) is much
// cheaper to catch here than after a wave of agents has already run against
// it.
const planBlockers = validateTasks(tasks)
if (planBlockers.length) {
  return { clean: false, remainingFindings: planBlockers, phaseReport: [], aborted: 'invalid-plan' }
}

// A10: a lookup every later stage needs -- fixGateStage walks dependsOn
// ancestors by id, implementPrompt looks up a `fix` task's repro-test
// dependency for the tests it must satisfy. Built once, from the validated
// plan, since ancestorIds()/ancestorsOfType() both take a byId map as an
// argument rather than assuming one global.
const tasksById = new Map(tasks.map((t) => [t.id, t]))

// ---------- A4: prompt scaffolding (lifted from scripts/light-loop.js @136-189) ----------
// Byte-identical for every agent in this run, so agents sharing model+effort in
// the same wave read it from the prompt cache instead of paying for it again.
const REPO_NOTE =
  (workdir
    // E7 (real launch 2026-09-15, Lite lane): "cd into workdir" alone is
    // advisory -- two implementer agents ignored it and edited the MAIN
    // checkout instead while workdir was a separate worktree, and nothing
    // caught it. Spell out the two mechanical requirements a git call and a
    // file edit must both satisfy, not just the intent.
    ? 'ALL work happens in the git worktree at "' + workdir + '" -- your process may start elsewhere, so `cd` into it before ANY command, and use ABSOLUTE paths under "' + workdir + '" for every file read/edit. Run EVERY git command as `git -C "' + workdir + '"` (never a bare `git` relying on your cwd). NEVER read, write, or run a command against any path outside "' + workdir + '", including another checkout of this same repository. '
    : 'You are working in the current directory, a git working tree. ') +
  'Never delete, move, stash, checkout, or "tidy" any file you did not create. ' +
  'Never run `git add -A`, `git stash`, `git checkout --`, `git reset --hard`, or `git push --force`. ' +
  'Edit files surgically: change only the lines the task needs.'
const ARTIFACT_NOTE = lessonsPath
  ? 'Lessons register (apply every entry relevant to what you review, write, or fix; cite the entry id when one changes your conclusion): "' + lessonsPath + '"'
  : ''
const GROUNDED_NOTE =
  'Before reporting, audit each claim against a tool result from this session. Report only what you can point to evidence for; if something is not verified, say so explicitly. If a command failed or was skipped, say so with the output.'
const SCRATCH_NOTE = 'Scratch files only under the OS temp directory, never inside the repo.'
const SCOPE_NOTE =
  "If, while working or testing, you find a pre-existing bug, a performance concern, or behavior the task doesn't mention, don't fix, optimize or extend it in this change unless the requested behavior cannot work without it; report it as a follow-up in your summary. Where the task is ambiguous, implement the reading its wording and the surrounding code most directly support, state that assumption in your summary, and don't build for the other readings as well. Verify your work however you like; scratch scripts and quick checks need not be kept. Commit tests only where the task asks for them or this repository already keeps tests for this kind of change, sized like the neighboring test files -- roughly one focused test per stated behavior -- and don't turn scratch checks into additional permanent test files. This is about extras only: implement every behavior the task asks for, completely."
const BATCH_NOTE =
  "First privately list what you need next; then request every item that doesn't depend on another's result in this one response."
function RUN_PREFIX() {
  return [REPO_NOTE, ARTIFACT_NOTE, GROUNDED_NOTE, SCRATCH_NOTE, SCOPE_NOTE, BATCH_NOTE].filter(Boolean).join('\n')
}
// The tag every prompt carries after RUN_PREFIX(). session-usage.mjs attributes
// tokens per phase by matching this exact shape; the middle dot is a literal
// U+00B7 character at runtime, escaped here so the source stays ASCII-only.
const TAG = (phase, label) => 'PHASE: ' + phase + ' \u00b7 LABEL: ' + label
// A14: every askAgent() call carries a real ledger phase name in o.phase
// (confirmed at every call site in this file); this tallies how many calls
// -- REAL usage, never a hardcoded placeholder -- were attributed to each,
// regardless of whether the call was ever awaited or what it returned. Read
// by phaseReport assembly at the end of the run.
const phaseAgentCounts = {}
function askAgent(prompt, opts) {
  const o = opts || {}
  phaseAgentCounts[o.phase] = (phaseAgentCounts[o.phase] || 0) + 1
  return agent(RUN_PREFIX() + '\n' + TAG(o.phase, o.label) + '\n' + prompt, o)
}
// One lightweight call per (model, effort) pair before a wave that shares it,
// so the real calls in that wave land on a warm cache instead of each writing
// its own copy.
const warmedThisRun = new Set()
async function warmUp(model, effort, phase) {
  const key = model + ':' + effort
  if (warmedThisRun.has(key)) return
  warmedThisRun.add(key)
  await askAgent('Reply with exactly: OK', { label: 'warmup', phase, model, effort })
}
async function warmUpWave(pairs, phase) {
  for (const pair of pairs) await warmUp(pair[0], pair[1], phase)
}
// TOOL-CALL CAP (mirrors light-loop's withOpusCap, renamed for the Fable-only
// routing table -- S3: Opus is the fallback tier only). Applied to every
// Fable agent call from A8 onward.
function withToolCap(promptText) {
  return promptText + '\n\nRead the pack / brief provided. Open a source file only for a hunk it cites. Hard cap: ' + CFG.caps.toolCalls + ' tool calls; if you need more, stop and report `needsMoreContext` with what is missing.'
}

// ---------- A5: Preflight (alias Baseline) ----------
const runId = typeof _args.runId === 'string' && _args.runId ? _args.runId : 'wf_' + (String(runDir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'run')
const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    contended: { type: 'boolean', description: 'true if the host is too busy to run this pipeline reliably right now (process/CPU contention)' },
    treeClean: { type: 'boolean' },
    resumeWritten: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['contended', 'treeClean', 'resumeWritten', 'note'],
}
function preflightPrompt(attempt) {
  return [
    'You are the PREFLIGHT gate for a task-loop pipeline run, attempt ' + attempt + ' of 3.',
    '1. Check host contention: count running node/npm/docker processes and current CPU load using whatever command this OS supports (Windows: `tasklist`; POSIX: `ps`/`uptime`). Count ONLY build-tool work: processes whose command line names jest, tsc, next, turbo, vitest, playwright, webpack, esbuild, docker, matlab, or npm run / npm test. Claude Code sessions and their MCP servers are node processes too (about 8 per open session) and do NOT count -- inspect command lines (Windows: PowerShell Get-CimInstance Win32_Process, or wmic process get commandline), never a bare tasklist count. Treat the host as contended only if more than 6 such build-tool processes are running, or CPU load looks pegged (>90% sustained across two samples a few seconds apart). Use judgment -- this is a heuristic, not a hard threshold from a config file.',
    '2. Run `git status --short` -- treeClean is true only if it prints nothing.',
    // Fix round 1 (finding 4): the brief specifies (runId, scriptPath, args)
    // -- args is what actually lets a killed run be relaunched with the same
    // inputs; task ids alone cannot. scriptPath is genuinely not available
    // anywhere in this engine's scope (not in _args, not exposed by any
    // Workflow global) -- write that fact literally rather than guessing a
    // substitute for it.
    '3. Write "' + runDir + '/RESUME.md" (create the directory first if needed) with exactly three things: this runId "' + runId + '"; scriptPath -- write the literal text "unavailable (no scriptPath in args or exposed by any Workflow global in this engine)", never a guess; and args -- the exact JSON object below, verbatim, so a killed run can be relaunched with the same inputs:\n' + JSON.stringify(_args) + '\nSet resumeWritten=true only if the write actually succeeded.',
    'Report contended, treeClean, resumeWritten, and note (one line).',
  ].join('\n')
}
async function runPreflight() {
  let result = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    result = await askAgent(preflightPrompt(attempt), { label: 'preflight', phase: 'Baseline', model: CFG.models.haiku, effort: CFG.effort.baseline, schema: PREFLIGHT_SCHEMA })
    if (result && !result.contended) break
  }
  return result
}
// ---------- A14: per-phase token telemetry ----------
// Adapted from pipeline.js.bak-2026-09-12 @2498-2536 (readSpent/startPhase/
// endPhase/estUsd). budget.spent() is one cumulative scalar for the whole
// run; startPhase/endPhase bracket it around each of the five sandbox
// `phase()` markers this engine actually calls (Baseline, Implement,
// Mutation probe, Verify, Final pass) so their `tokens` are a real, measured
// delta -- never a hardcoded placeholder. The other five ledger phase names
// (Author tests, Red gate, Gate & Review, Fix, UI verify) run only AS PART
// OF the per-task chain inside the Implement wave loop (interleaved across
// tasks in parallel waves, plus the post-loop ui-reverify pass) -- a single
// shared scalar cannot isolate their own token cost under that concurrency,
// so phaseReport assembly reports them tokens:null, overlappedWith:
// 'Implement', exactly the old engine's own markOverlapped philosophy: an
// unknown reading is never reported as a guessed number. agents/rawFindings
// for every phase (anchor or overlapped) are real tallies -- phaseAgentCounts
// (every askAgent call) and findings.filter(f => f.phase === title) (every
// finding actually recorded under that name) -- never placeholders either.
function readSpent() {
  try {
    if (!budget || typeof budget.spent !== 'function') return null
    const v = budget.spent()
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch (e) {
    return null
  }
}
const PHASE_TITLES = ['Baseline', 'Author tests', 'Red gate', 'Implement', 'Gate & Review', 'Verify', 'UI verify', 'Mutation probe', 'Fix', 'Final pass']
const phaseStats = {}
for (const title of PHASE_TITLES) phaseStats[title] = { at: null, sum: 0, unknown: false, open: 0, contaminated: false }
// T2 cost-plan: the actual token-delta bracket, shared by startPhase/endPhase
// (the five run-level anchors, called once each) AND meterStage (below, the
// five per-task phases). `open` counts brackets currently open for `title`;
// a SECOND one opening before the first closes means two tasks in the same
// wave entered the same titled phase concurrently -- budget.spent() is one
// shared cumulative scalar, so a delta computed across that overlap would
// double-count or misattribute tokens between them. Mark the title
// permanently `contaminated` (unknown) the moment that happens rather than
// ever report a guessed number; bracketClose no-ops for every nested/
// overlapping close once contaminated (or while still open elsewhere).
function bracketOpen(title) {
  const s = phaseStats[title]
  s.open += 1
  if (s.open > 1) {
    s.contaminated = true
    return
  }
  s.at = readSpent()
  if (s.at == null) s.unknown = true
}
function bracketClose(title) {
  const s = phaseStats[title]
  s.open = Math.max(0, s.open - 1)
  if (s.contaminated || s.open > 0) return
  const now = readSpent()
  if (s.at == null || now == null) s.unknown = true
  else s.sum += Math.max(0, now - s.at)
  s.at = null
}
function startPhase(title) {
  phase(title)
  bracketOpen(title)
}
function endPhase(title) {
  bracketClose(title)
}
// T2 cost-plan: wraps a per-task stage function (chainForType, below) in the
// SAME bracket the five run-level anchors use, so Author tests/Red gate/
// Gate & Review/Fix/UI verify stop reporting estUsd:null unconditionally --
// they get a real number whenever exactly one task is in that titled stage
// at a time, and an honest `contaminated` (see bracketOpen) otherwise. Never
// calls phase() itself -- that global per-run marker stays owned by
// startPhase/the five anchors; this only adds the token-delta bookkeeping.
function meterStage(title, stageFn) {
  return async (t) => {
    bracketOpen(title)
    try {
      return await stageFn(t)
    } finally {
      bracketClose(title)
    }
  }
}
function estUsd(tokens, model) {
  const p = CFG.prices[model]
  if (!p) return null
  // Rich usage {input, output, cacheWrite1h, cacheRead} token counts, priced
  // at each class's own rate -- the correct math once a caller can supply
  // it. No caller in this engine can yet: budget.spent() (readSpent, above)
  // is one cumulative scalar with no input/output/cache split, so every
  // current call falls through to the scalar fallback below.
  if (tokens && typeof tokens === 'object') {
    const { input = 0, output = 0, cacheWrite1h = 0, cacheRead = 0 } = tokens
    const usd = (input / 1e6) * p.input + (output / 1e6) * p.output + (cacheWrite1h / 1e6) * p.cacheWrite1h + (cacheRead / 1e6) * p.cacheRead
    return { usd: Math.round(usd * 100) / 100, approx: false }
  }
  if (tokens == null) return null
  // Fallback: a single scalar token count with no class breakdown, priced
  // entirely at the output rate as the old engine did -- the higher of the
  // two base rates, so this over-estimates rather than under- (the safer
  // direction for a cost gate). Flagged approx so a reader never mistakes
  // it for the real input/output/cache mix.
  return { usd: Math.round((tokens / 1e6) * p.output * 100) / 100, approx: true }
}

startPhase('Baseline')
const preflight = await runPreflight()
if (preflight && preflight.contended) {
  // Abort here means ZERO further agent calls of any kind -- the preflight
  // attempts already spent are the only cost of a contended host.
  return { aborted: 'host-contention', phaseReport: [] }
}

// ---------- A6: Baseline (gates, grounding, manifest, risk, harness check) ----------
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
// failures say nothing about this change, so a later gate (A8+) excludes
// them from its pass/fail decision via isBadCommand()/gateProblem() below;
// Baseline itself also strips them out of manifestResult.validCommands (B),
// so every later phase reading the manifest never sees a known-broken
// command again.
const badCommandSet = new Set()
const isBadCommand = (c) => badCommandSet.has(normCmd(c))
// Reused by every later gate call site (A8+): a `real` (non-baseline-broken)
// failure blocks; a gate that only failed on already-broken commands does not.
function gateProblem(g) {
  if (!g) return 'The gate agent died or was skipped, so no verification evidence exists for this run.'
  const results = Array.isArray(g.results) ? g.results : []
  const failed = results.filter((r) => r && r.pass === false)
  const real = failed.filter((r) => !isBadCommand(r.command))
  if (real.length) return JSON.stringify(real)
  if (g.pass === true) return null
  if (failed.length) return null // every failure was a command already broken at baseline
  return 'The gate reported pass:false but listed no failing command -- treat it as unverified, not as a pass.'
}

const perRoundCmds = Array.isArray(verifyCommands.perRound) ? verifyCommands.perRound : []
const finalCmds = Array.isArray(verifyCommands.final) ? verifyCommands.final : []
const baselineCommands = uniqueCommands([...perRoundCmds, ...finalCmds])
const planPaths = uniquePaths([_args.buildPlanPath, _args.testPlanPath].filter(Boolean))
// Fix round 1 (finding 3): groundingPrompt fact-checks claims a PLANNING
// artifact makes about the repo -- that is the build/test plan, not the
// lessons register (a reference doc, not a planning artifact making claims
// about this run). Grounding lessonsPath too would be a separate, deliberate
// decision this round does not make -- it stays excluded here on purpose.
const groundingArtifacts = uniquePaths([...planPaths])
// Files this run's tasks intend to touch -- they may not exist yet, so the
// manifest classifies them alongside the diff (created vs edited, C). A10:
// also include every revert-probe's single `file` -- the checksum:after
// in-script comparison (below, Implement phase) reads its "before" digest
// from THIS manifest, so a probed file the manifest never saw would have no
// baseline to compare against.
const plannedFiles = uniquePaths([
  ...[].concat(...tasks.map((t) => t.files || []), ...tasks.map((t) => t.tests || [])),
  ...tasks.filter((t) => t.type === 'revert-probe' && t.file).map((t) => t.file),
])

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    cwd: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          pass: { type: 'boolean' },
          executed: { type: 'number' },
          summary: { type: 'string' },
        },
        required: ['command', 'pass'],
      },
    },
  },
  required: ['pass', 'results'],
}
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['severity', 'file', 'summary', 'detail'],
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
          exists: { type: 'boolean', description: 'true if this path currently exists on disk right now -- a planned file may be false' },
          digest: { type: 'string', description: '`git hash-object` digest when the file exists; empty string otherwise' },
          risk: { type: 'string', enum: ['HIGH', 'LOW'], description: 'HIGH iff the CHANGE (diff hunks, or the intended change for a file that does not exist yet) touches money/tax/pricing math, auth/permissions/session, tenancy/ownership scoping, migrations/schema, PII, or payments -- never merely that the file lives in such a module; config strings, allow-lists, labels, docs and code-map edits are LOW even inside such a module. Unknown or unreadable is HIGH.' },
          changedLines: { type: 'number', description: 'added+deleted lines from `git diff --numstat`; 0 when the file does not exist yet' },
        },
        required: ['path', 'status', 'exists', 'digest', 'risk', 'changedLines'],
      },
    },
    validCommands: { type: 'array', items: { type: 'string' }, description: 'the supplied verify commands that can actually run in this repo, spelled exactly as given' },
    artifacts: { type: 'array', items: { type: 'string' }, description: 'the supplied artifact paths that exist on disk' },
    planBytes: {
      type: 'object',
      description: '`wc -c` of the build/test plan artifacts, when supplied',
      properties: { build: { type: 'number' }, test: { type: 'number' } },
    },
  },
  required: ['files', 'validCommands', 'artifacts'],
}
const HARNESS_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          issue: { type: 'string' },
          remedy: { type: 'string' },
        },
        required: ['file', 'issue'],
      },
    },
  },
  required: ['issues'],
}

function baselineGatePrompt(commands) {
  return [
    "You are the BASELINE gate. Nothing has been written yet: you run the project's verification commands against the working tree exactly as you find it, to learn which of them work AT ALL.",
    'Run these commands from the repo root, one at a time, in order:',
    ...commands.map((c) => '- ' + c),
    'Rules: do NOT fix anything, do NOT create, modify or delete any file, do NOT install anything, and do NOT adjust, re-flag or substitute a command that fails -- run each one EXACTLY as written. A failure here is the information we want, not a problem to solve.',
    'Report each command: pass:true only if it actually ran and succeeded; pass:false if it exits nonzero, errors, or cannot be run at all (missing script, missing binary, wrong path, wrong directory) -- with the key error lines quoted verbatim in summary. Also report `executed` = the number of tests (or files checked) the tool says it ran, -1 when it prints no count. Overall pass = every command passed. Report the working directory you ran in as `cwd`.',
  ].join('\n')
}
function groundingPrompt(paths) {
  return [
    'You are the artifact grounding check. The planning artifacts below make factual claims about THIS repository. Find the claims that are false.',
    'Artifacts -- read every one in full:',
    ...paths.map((p) => '- ' + p),
    'Extract every MECHANICALLY CHECKABLE claim: file paths, directory paths, shell commands, package-manifest scripts, config keys, and exported symbols (functions, classes, constants, types) attributed to a specific file. Ignore every other kind of statement.',
    'Verify each against the repo as it is right now: the path exists; the script exists in the package manifest; the config key exists in that config file; the symbol is actually exported by the file said to export it. Use `ls`, `cat` and `grep` -- do not guess, and do not edit anything.',
    "Report ONLY claims that do not hold. Use file: '(artifact)' for every finding, and in detail give the artifact path, the claim quoted exactly, and what the repo actually contains instead. severity: major for a path, directory, command, script or config key that does not exist; minor for a symbol you could not resolve.",
    'Do NOT report a path, file or symbol the artifacts say this change WILL CREATE -- it is supposed to be missing. Do NOT critique wording, design, completeness, feasibility, or quality -- an empty findings list is a good answer.',
  ].join('\n')
}
function manifestPrompt(planned, commands, artifactPaths, planPathsArg) {
  return [
    'You are the context manifest builder. Report FACTS about this repository as it is right now. Do NOT summarize, interpret, judge or review the change -- later agents read the diff themselves and must not inherit your reading of it.',
    "1. FILES. Run `git status --short` and `git diff --numstat` and list every changed and untracked file. ALSO list every file this run's tasks intend to touch, even if it does not exist yet:",
    ...(planned.length ? planned.map((f) => '   - ' + f) : ['   (none supplied)']),
    '   For each file report: path (repo-relative, forward slashes), status (modified | added | untracked | deleted | planned), exists (true if the path currently exists on disk -- check directly, never assume a planned file is absent), digest (`git hash-object <path>` when it exists, else empty string), and changedLines (added+deleted from --numstat; 0 when the file does not exist yet or no count is available).',
    '2. RISK. Classify every file HIGH or LOW. HIGH iff the CHANGE (the diff hunks, or for a planned file that does not exist yet, the intended change) touches money/tax/pricing math, auth/permissions/session, tenancy or ownership scoping, migrations/schema, PII, or payments. A config string, an allow-list entry, a label, a doc, or a code-map edit is LOW even inside a finance/admin module -- risk follows the CHANGE, never the module it lives in. If you cannot read a file, or are not sure, classify it HIGH -- unknown is HIGH, never LOW.',
    commands.length
      ? '3. COMMANDS. For each command below decide STATICALLY whether it could run at all here (the npm script exists in the right package manifest, the file or binary it names exists, the directory it needs exists). Do NOT execute any of them -- another agent is running them right now. Return in validCommands only the ones that look runnable, spelled EXACTLY as given:\n' + commands.map((c) => '   - ' + c).join('\n')
      : '3. COMMANDS. None were supplied -- return an empty validCommands.',
    artifactPaths.length
      ? '4. ARTIFACTS. Return in artifacts the subset of these paths that EXIST on disk:\n' + artifactPaths.map((p) => '   - ' + p).join('\n')
      : '4. ARTIFACTS. None were supplied -- return an empty artifacts list.',
    planPathsArg.length
      ? '5. PLAN SIZE. Run `wc -c` on each of these planning artifacts and report the total bytes as planBytes (build = the build-plan-shaped path(s), test = the test-plan-shaped path(s); 0 for a kind not supplied):\n' + planPathsArg.map((p) => '   - ' + p).join('\n')
      : '5. PLAN SIZE. None supplied -- return planBytes {build:0, test:0}.',
    'Read only. Do NOT modify, create or delete any file, do NOT run builds, tests or installs, and do NOT run any command that writes.',
  ].join('\n')
}
function harnessCheckPrompt(files) {
  return [
    'You are the TEST-HARNESS INTEGRITY check -- read-only, and you run BEFORE any test is written. This is a bugfix-mode run; the tasks in this plan change a service surface, and the test files listed already exist or are about to be extended. Find where the EXISTING harness will break against that change.',
    'Test files this run will write or extend:',
    ...files.map((f) => '- ' + f),
    "For every one of those test files that ALREADY EXISTS -- and every shared fixture, factory, builder or mock helper it imports -- check its mocks and fixtures against the tasks' briefs: a mocked service missing a method a task adds a call to, a fixture value a new validator will reject, a stub whose return shape no longer matches, a hardcoded DTO literal missing a newly required field, a spy asserting a signature that changed. Skip files that do not exist yet; say nothing about them.",
    'Report ONE issue per inconsistency: file, line, what will break, and a one-line remedy. Report NOTHING else. An empty issues list is a good answer. This check never blocks the run -- it only informs the test authors.',
    'Read only: do NOT modify, create or delete any file, and do NOT run builds, tests or installs.',
  ].join('\n')
}

// "created" (a build-plan blocker candidate) means the manifest reports the
// target ABSENT -- an existing planned file is "edited" and never blocked
// (C). --passWithNoTests is demanded only when EVERY target this command
// names is absent; a command mixing an existing and a not-yet-created
// target is fine.
function validateJestCommands(commands, existsMap) {
  const problems = []
  for (const cmd of commands) {
    if (!/\bjest\b/i.test(cmd)) continue
    const tokens = cmd.trim().split(/\s+/).filter(Boolean)
    const jestIdx = tokens.findIndex((t) => /\bjest\b/i.test(t))
    const rest = tokens.slice(jestIdx + 1)
    if (rest.includes('--passWithNoTests')) continue
    const VALUE_FLAGS = new Set(['-t', '--testNamePattern', '--testPathPattern', '-c', '--config', '--rootDir', '--selectProjects', '--maxWorkers', '-w', '--testTimeout'])
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
    if (!targets.length) continue
    const cdMatch = /^cd\s+([^\s&]+)\s*&&\s*/.exec(cmd.trim())
    const cdDir = cdMatch ? stripQuotes(cdMatch[1]) : null
    const resolveTarget = (t) => {
      const isAbsolute = /^([a-zA-Z]:)?[\\/]/.test(t)
      if (cdDir && !isAbsolute) return cdDir + '/' + t
      return t
    }
    const absentTargets = targets.filter((t) => existsMap.get(normPath(resolveTarget(t))) === false)
    if (absentTargets.length && absentTargets.length === targets.length) {
      problems.push({
        file: '(build-plan)',
        severity: 'blocker',
        phase: 'Baseline',
        summary: "Jest command's target path(s) do not exist yet, with no --passWithNoTests: `" + cmd + '`',
        detail: 'Every target this command names (' + targets.join(', ') + ') is reported ABSENT by the baseline manifest, and without --passWithNoTests Jest exits nonzero on zero matched test files, so this gate is void until those files land.',
        fixHint: 'Add --passWithNoTests if running before the test files exist is intentional, or point this command at files that already exist.',
      })
    }
  }
  return problems
}

const findings = []
let baselineResult = {
  ran: false,
  commands: baselineCommands,
  badCommands: [],
  gate: { ran: false, pass: null, results: [] },
  grounding: { ran: false, artifacts: groundingArtifacts, findings: [] },
}
let manifestResult = { ran: false, files: [], validCommands: [], artifacts: [], planBytes: { build: 0, test: 0 } }
const existsMap = new Map()
const riskMap = new Map()
const wantHarnessCheck = mode === 'bugfix' && plannedFiles.length > 0
let harnessCheck = { ran: false, issues: [], skipped: mode === 'bugfix' ? (wantHarnessCheck ? null : 'no-planned-files') : 'feature-mode' }

{
  const baselineOut = await parallel([
    () => (baselineCommands.length ? askAgent(baselineGatePrompt(baselineCommands), { label: 'baseline-gate', phase: 'Baseline', model: CFG.models.haiku, effort: CFG.effort.baseline, schema: GATE_SCHEMA }) : Promise.resolve(null)),
    () => (groundingArtifacts.length ? askAgent(groundingPrompt(groundingArtifacts), { label: 'baseline-grounding', phase: 'Baseline', model: CFG.models.haiku, effort: CFG.effort.baseline, schema: FINDINGS_SCHEMA }) : Promise.resolve(null)),
    () => askAgent(manifestPrompt(plannedFiles, baselineCommands, groundingArtifacts, planPaths), { label: 'baseline-manifest', phase: 'Baseline', model: CFG.models.haiku, effort: CFG.effort.baseline, schema: MANIFEST_SCHEMA }),
    () => (wantHarnessCheck ? askAgent(harnessCheckPrompt(plannedFiles), { label: 'harness-check', phase: 'Baseline', model: CFG.models.sonnet, effort: 'low', schema: HARNESS_SCHEMA }) : Promise.resolve(null)),
  ])

  if (baselineCommands.length) {
    const bGate = baselineOut[0]
    if (bGate) {
      const bResults = Array.isArray(bGate.results) ? bGate.results : []
      for (const r of bResults) {
        if (!r || r.pass !== false) continue
        const cmd = r.command || ''
        if (!normCmd(cmd) || isBadCommand(cmd)) continue
        badCommandSet.add(normCmd(cmd))
        baselineResult.badCommands.push(cmd)
        findings.push({
          file: '(gate-command)',
          severity: 'major',
          phase: 'Baseline',
          summary: '`' + cmd + '` already fails on the unmodified baseline tree -- the command is broken, not the code',
          detail: 'Baseline output: ' + (r.summary || '(none reported)') + '. This command failed BEFORE any agent wrote anything, so its failures during this run are not evidence about the change. It is excluded from every later gate and cannot make the result unclean.',
        })
      }
      baselineResult.gate = { ran: true, pass: !!bGate.pass, results: bResults }
    } else {
      baselineResult.gate = { ran: true, pass: null, results: [] }
    }
  }

  if (groundingArtifacts.length) {
    const bGround = baselineOut[1]
    if (bGround) {
      const groundFindings = (Array.isArray(bGround.findings) ? bGround.findings : []).map((f) => ({
        ...f,
        file: '(artifact)',
        phase: 'Baseline',
        severity: f.severity === 'blocker' ? 'major' : f.severity,
      }))
      baselineResult.grounding = { ran: true, artifacts: groundingArtifacts, findings: groundFindings }
      findings.push(...groundFindings)
    } else {
      baselineResult.grounding = { ran: true, artifacts: groundingArtifacts, findings: [] }
    }
  }

  const bManifest = baselineOut[2]
  // Fix round 1 (finding 1): a dead/skipped manifest agent used to leave
  // existsMap/riskMap silently empty with no record of why -- surfaced now as
  // a major finding instead of a quiet fall-through to "every file looks
  // fine".
  if (!bManifest) {
    findings.push({
      file: '(baseline-manifest)',
      severity: 'major',
      phase: 'Baseline',
      summary: 'The baseline manifest agent returned nothing -- every file defaults to HIGH risk and "created vs edited" existence facts are unavailable.',
      detail: 'baseline-manifest died or was skipped, so existsMap/riskMap carry no per-file facts except any tasks[].risk override. Every unclassified file is therefore treated as HIGH risk (unknown-is-HIGH) rather than silently LOW, and every planned file the Jest-target check considers is treated as ABSENT, which may produce a spurious (build-plan) blocker for a file that already exists.',
    })
  }
  const mFiles = bManifest && Array.isArray(bManifest.files) ? bManifest.files.filter((f) => f && f.path) : []
  for (const f of mFiles) {
    const k = normPath(f.path)
    existsMap.set(k, f.exists !== false) // absent ONLY when explicitly false
    riskMap.set(k, f.risk === 'LOW' ? 'LOW' : 'HIGH')
  }
  // tasks[].risk explicit ALWAYS wins over the classifier -- applied to every
  // file the task owns.
  for (const t of tasks) {
    if (t.risk !== 'HIGH' && t.risk !== 'LOW') continue
    for (const f of [...(t.files || []), ...(t.tests || [])]) riskMap.set(normPath(f), t.risk)
  }
  // tasks[].introducesObservable (boolean; or the brief containing the
  // literal token INTRODUCES-OBSERVABLE) -- E4: a task whose whole point is
  // to make a not-yet-existing observable appear (e.g. a CLI line, a log
  // message) cannot pre-implementation red-gate on that observable's
  // absence looking like "the vulnerability" -- the only honest RED state is
  // "nothing printed / import-undefined". redCheckStage (below) reads this
  // flag via taskIntroducesObservable() to accept that structural RED
  // without remediation; it is read there, not validated here.
  if (bManifest) {
    manifestResult = {
      ran: true,
      files: mFiles.map((f) => {
        const k = normPath(f.path)
        return { path: k, status: f.status || '', exists: existsMap.get(k), digest: f.digest || '', risk: riskMap.get(k) || 'HIGH', changedLines: typeof f.changedLines === 'number' ? f.changedLines : 0 }
      }),
      // B: strip every already-known-broken command -- every LATER gate that
      // reads validCommands (instead of re-discovering them itself) never
      // sees a command this run already proved broken.
      validCommands: (Array.isArray(bManifest.validCommands) ? bManifest.validCommands : []).filter((c) => !isBadCommand(c)),
      artifacts: Array.isArray(bManifest.artifacts) ? bManifest.artifacts : [],
      planBytes: bManifest.planBytes && typeof bManifest.planBytes === 'object' ? { build: Number(bManifest.planBytes.build) || 0, test: Number(bManifest.planBytes.test) || 0 } : { build: 0, test: 0 },
    }
  }

  // (c) plan-size cap: over CFG.caps.planBytes[scale] -> a major (artifact)
  // finding, routed to a Sonnet low trim pass (never a silent proceed).
  const planCap = CFG.caps.planBytes[scale] || CFG.caps.planBytes.small
  if (manifestResult.planBytes.build > planCap.build) {
    findings.push({ file: '(artifact)', severity: 'major', phase: 'Baseline', summary: 'Build plan is ' + manifestResult.planBytes.build + ' bytes, over the "' + scale + '" cap of ' + planCap.build, detail: 'Route to a Sonnet low trim pass before Author tests/Implement read it.' })
  }
  if (manifestResult.planBytes.test > planCap.test) {
    findings.push({ file: '(artifact)', severity: 'major', phase: 'Baseline', summary: 'Test plan is ' + manifestResult.planBytes.test + ' bytes, over the "' + scale + '" cap of ' + planCap.test, detail: 'Route to a Sonnet low trim pass before Author tests/Implement read it.' })
  }

  // (a)/C: Jest-target validation, driven by the manifest's own exists facts
  // instead of blindly assuming every planned file is absent.
  findings.push(...validateJestCommands(baselineCommands, existsMap))

  if (wantHarnessCheck) {
    const hc = baselineOut[3]
    harnessCheck = { ran: !!hc, issues: hc && Array.isArray(hc.issues) ? hc.issues : [], skipped: null }
  }
  baselineResult.ran = true
}

// ---------- A7: waves (dependsOn order, disjoint-file scheduling) ----------
// Lifted from pipeline.js.bak-2026-09-12 @2851-2907 (param renamed `pkgs` ->
// `tasks`, `package` -> `task` in the issue text). A3's detectGraphIssues()
// already blocks an unknown/self/cyclic dependsOn edge before any agent
// runs, so these issues[] should never fire on a plan that reached this
// point -- kept as defensive redundancy, matching the old engine's own
// belt-and-suspenders shape.
function buildWaves(tasks) {
  const issues = []
  const byId = new Map()
  for (const t of tasks) byId.set(t.id, t)

  const ordered = []
  const state = {} // id -> 1 = on the stack, 2 = emitted
  function visit(t) {
    if (state[t.id] === 2) return
    if (state[t.id] === 1) return // cycle -- reported below; do not recurse forever
    state[t.id] = 1
    for (const dep of t.dependsOn || []) {
      const d = byId.get(dep)
      if (!d) {
        issues.push('Task ' + t.id + ' declares dependsOn "' + dep + '", which matches no task id -- that ordering constraint was DROPPED and ' + t.id + ' may have run concurrently with, or before, the work it depends on.')
        continue
      }
      if (d === t) {
        issues.push('Task ' + t.id + ' declares dependsOn on itself -- ignored.')
        continue
      }
      if (state[d.id] === 1) {
        issues.push('Circular dependsOn between ' + t.id + ' and ' + d.id + ' -- the cycle cannot be ordered, so one of those edges was DROPPED.')
        continue
      }
      visit(d)
    }
    state[t.id] = 2
    ordered.push(t)
  }
  for (const t of tasks) visit(t)

  const waves = []
  const waveOf = {} // task id -> wave index
  // Fix round 1 (finding 2): compare `[...files, ...tests]` (not `files`
  // alone -- two tasks extending the same test file are a write conflict
  // too) through `normPath` (not raw strings -- so this agrees with
  // validateTasks' own shared-file rule about what counts as "the same
  // file").
  const ownedOf = (q) => new Set([...(q.files || []), ...(q.tests || [])].map(normPath))
  for (const t of ordered) {
    const files = ownedOf(t)
    const minWave = (t.dependsOn || []).reduce((m, dep) => (waveOf[dep] != null ? Math.max(m, waveOf[dep] + 1) : m), 0)
    let idx = -1
    for (let i = minWave; i < waves.length; i++) {
      if (!waves[i].some((q) => [...ownedOf(q)].some((f) => files.has(f)))) { idx = i; break }
    }
    if (idx === -1) { waves.push([t]); idx = waves.length - 1 }
    else waves[idx].push(t)
    waveOf[t.id] = idx
  }
  return { waves, issues }
}
// Which (model, effort) pairs a wave's real agent calls (A8+) will use --
// warmed once per pair before the wave dispatches, so those calls land on a
// warm prompt cache. Delegates straight to isHighRisk() (defined further
// down; function declarations hoist, so this is safe -- pairsFor is only
// ever CALLED from the wave loop at the bottom of the script, long after
// isHighRisk's declaration has been processed). Fix round 1, finding 12:
// this used to keep its own separate copy of the HIGH/LOW rule and, in
// keeping a separate copy, missed isHighRisk's explicit `t.risk === 'LOW'`
// override -- an explicitly LOW-risk task could still warm the Fable pair
// here while every other A8/A9 stage correctly routed it to Sonnet.
// Delegating means the two structurally cannot disagree again.
function pairsFor(wave) {
  const seen = new Set()
  const pairs = []
  for (const t of wave) {
    const high = isHighRisk(t)
    const model = CFG.models.sonnet // implementation is never Fable (ruling 2026-09-13); HIGH keeps implementHigh effort
    const effort = high ? CFG.effort.implementHigh : CFG.effort.implement
    const key = model + ':' + effort
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push([model, effort])
  }
  return pairs
}
// ---------- A8/A9: per-task chain ----------
const M = CFG.models

// A15: profile selection (S6). args.profile, when literally 'lean' or
// 'standard', always wins; otherwise a small-scale run with no HIGH-risk
// task anywhere -- neither an explicit risk:'HIGH' on a task nor a
// Baseline-manifest file marked HIGH -- defaults to 'lean' (superpowers
// parity: no separate test author, no probes, reviewer always Sonnet,
// Baseline skips the final-command check); everything else defaults to
// 'standard' (the full S1-S5 design this engine already implements).
// manifestResult is fully populated by the time this runs (Baseline's
// `await parallel(...)` above already resolved).
// Fix (repro-test red-check under lean): 'lean's "skip the separate test
// author, let the RED check parse the implementer's own RED section"
// design was conceived for `feature`-type tasks, which DO have an
// implementer whose report can carry an observed RED-then-GREEN. A
// `repro-test` task's chain (chainForType, below) has NO implementer at
// all -- [briefStage, testAuthorStage, redCheckStage, finishStage] -- so
// under lean both testAuthorStage and redCheckStage short-circuit
// (profile.separateTestAuthor:false) and the task makes ZERO agent calls,
// reporting a fabricated clean:true having proven nothing about the bug's
// reproduction. mode:'bugfix' runs and any run containing a repro-test
// task are exactly the cases that depend on that mechanical, behavioral
// RED check (the house Pipeline Law's "repro-first tests that must fail
// on the bug's own wrong value") -- so both force 'standard' here, the
// SAME way explicitHigh/manifestHigh already do, and under the same
// args.profile-always-wins precedence. This does NOT touch lean's
// behavior for ordinary feature-type runs.
const explicitHigh = tasks.some((t) => t.risk === 'HIGH')
const manifestHigh = (manifestResult.files || []).some((f) => f.risk === 'HIGH')
const hasReproTest = tasks.some((t) => t.type === 'repro-test')
const forceStandardForBugfix = mode === 'bugfix' || hasReproTest
const profileName =
  _args.profile === 'lean' || _args.profile === 'standard'
    ? _args.profile
    : scale === 'small' && !explicitHigh && !manifestHigh && !forceStandardForBugfix
      ? 'lean'
      : 'standard'
const profile = CFG.profiles[profileName]

function taskDir(id) { return runDir + '/tasks/' + id }
// Fix 1: builds the 'node "<abs path>/<script>.mjs"' prefix every one of the
// 4 helper-script invocations uses, from the launcher-supplied scriptsDir --
// never a bare relative 'node scripts/<script>.mjs' (that only resolves when
// the invoking agent's cwd happens to be dev-pipeline's own directory, never
// true for a real run). Returns null when scriptsDir is empty so each call
// site can treat "no scriptsDir" as a hard, visible blocker instead of
// silently falling back to the broken relative form -- a silent fallback
// would just reproduce this exact bug for anyone who forgets to pass the new
// arg (see the missing-scriptsDir handling at each call site below).
// Forward slashes only, and the path double-quoted (it may contain spaces,
// e.g. under "C:\\Users\\<name>\\..."): Node's child_process/shell resolves
// forward-slash paths correctly on Windows too, so this stays portable and
// ASCII-only.
function scriptCmd(name) { return scriptsDir ? 'node "' + scriptsDir + '/' + name + '"' : null }
// The single HIGH/LOW rule every A8/A9 stage -- and pairsFor() above -- reads
// through: an explicit t.risk always wins (including an explicit LOW); an
// unclassified owned file defaults HIGH ("unknown is HIGH", matching the
// Baseline manifest's own rule). Fix round 1, finding 12: pairsFor() now
// calls this directly instead of keeping a separate copy of the rule.
function isHighRisk(t) {
  if (t.risk === 'HIGH' || t.risk === 'LOW') return t.risk === 'HIGH'
  const owned = [...(t.files || []), ...(t.tests || [])].map(normPath)
  return owned.some((f) => riskMap.get(f) !== 'LOW')
}
// Every judgment-tier call (Fable AND Opus) gets the tool-call cap: they read the
// pack and never explore — an Opus reviewer past 12 tool calls is mis-routed and
// its cost is cache reads (lead ruling 2026-09-14, after the cost investigation).
function fableSafe(model, promptText) { return (model === M.fable || model === M.opus) ? withToolCap(promptText) : promptText }

// Fix 2 (real smoke-run finding): this schema originally had no exitCode
// field, so a script invocation that failed to even resolve its own path
// (Fix 1's bug) was silently swallowed -- the agent reported a fabricated
// placeholder ("task-brief-script-missing", bytes:0) that briefStage/the
// fix-brief call site accepted blindly as a real path, degrading silently
// instead of blocking. `exitCode` is required so those call sites can tell
// "the script ran and wrote its output" apart from "the agent reported
// something, but the script never actually ran" -- the exact distinction
// PACK_SCRIPT_SCHEMA/packStage already made correctly (proven by the real
// smoke run, which produced a genuine (pack) blocker).
const SCRIPT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    out: { type: 'string', description: 'path the script wrote its output to' },
    bytes: { type: 'number' },
    truncated: { type: 'boolean' },
    sections: { type: 'array', items: { type: 'string' } },
    exitCode: { type: 'number', description: 'the script process exit code -- 0 only if its output file was actually written' },
  },
  required: ['out', 'bytes', 'truncated', 'exitCode'],
}
// Lifted from pipeline.js.bak-2026-09-12 @799-822 (RED_RUN_SCHEMA), verbatim
// shape -- the red run's job is to capture output, not to judge it.
const RED_RUN_SCHEMA = {
  type: 'object',
  properties: {
    ran: { type: 'boolean', description: 'true if every command actually executed -- a FAILING test run still counts as executed' },
    cwd: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'number' },
          output: { type: 'string', description: 'runner output verbatim: every failing test name with its failure message, plus pass/fail/skip counts' },
        },
        required: ['command', 'exitCode', 'output'],
      },
    },
  },
  required: ['ran', 'results'],
}
// Adapted from pipeline.js.bak-2026-09-12 @823-845 (RED_AUDIT_SCHEMA):
// trimmed to the STRUCTURAL half only (behaviorallyRed/properlyRed are a
// repro-test/A10 concern over a task's stated wrongValue, out of this
// task group's scope).
const RED_AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    structurallyRed: { type: 'boolean', description: 'true ONLY if every named test ran and failed on an ASSERTION -- none passed, none errored, none was skipped' },
    tests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          test: { type: 'string' },
          outcome: { type: 'string', enum: ['assertion-failure', 'error', 'passed', 'not-run'] },
          note: { type: 'string' },
        },
        required: ['test', 'outcome', 'note'],
      },
    },
    blockers: { type: 'array', items: { type: 'string' } },
    remediation: { type: 'string', description: 'the exact edits a test author should make to fix the STRUCTURAL problem(s); empty string if structurallyRed' },
  },
  required: ['structurallyRed', 'tests', 'blockers', 'remediation'],
}
// Lifted from pipeline.js.bak-2026-09-12 @754-763 (IMPL_SCHEMA) verbatim;
// reused as-is for every fix-round executor report too (A9) -- same shape.
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
// S3's reviewer verdict schema, as specified in the task 8 brief verbatim.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    specCompliance: { type: 'string', enum: ['pass', 'fail', 'partial'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          scenario: { type: 'string', description: 'the concrete input/state that produces the wrong behavior' },
        },
        required: ['severity', 'file', 'summary', 'scenario'],
      },
    },
    assessment: { type: 'string', enum: ['approved', 'needs-fixes'] },
  },
  required: ['specCompliance', 'findings', 'assessment'],
}
// Adapted from pipeline.js.bak-2026-09-12 @1237-1270 (FIX_PLAN_SCHEMA):
// dropped `waves`/`route`/`ruled` -- this run's fix loop is single-task and
// sequential (no cross-finding concurrency to schedule, no Opus routing to
// pick), so those fields would just go unread. `key` replaces the old
// numeric index, matching fixKey() below.
const FIX_DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'the finding key this decision is about, copied exactly from the findings list' },
          action: { type: 'string', enum: ['fix', 'dispute', 'defer'] },
          design: { type: 'string', description: 'for "fix": 2-6 sentences -- what changes, where, and what must NOT change' },
          invariant: { type: 'string' },
          tests: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['key', 'action', 'design', 'invariant', 'tests', 'reason'],
      },
    },
    note: { type: 'string', description: 'this round\'s plan in one paragraph' },
  },
  required: ['decisions', 'note'],
}
// Fix round 1, finding 1/2: packStage's and the re-review's review-pack.mjs
// calls must never be trusted on a bare `out` path alone -- a non-zero exit
// or a missing pack.md must become a task blocker, never a silent fallback.
// `exitCode` is required so the engine can tell "the script ran and wrote
// pack.md" apart from "the agent reported something, but the script failed".
const PACK_SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    out: { type: 'string', description: 'path the script wrote its output to' },
    bytes: { type: 'number' },
    truncated: { type: 'boolean' },
    sections: { type: 'array', items: { type: 'string' } },
    exitCode: { type: 'number', description: 'the review-pack.mjs process exit code -- 0 only if pack.md was actually written' },
  },
  required: ['out', 'bytes', 'truncated', 'exitCode'],
}
const GIT_SHA_SCHEMA = { type: 'object', properties: { sha: { type: 'string' } }, required: ['sha'] }
// Real launch wf_a3822206-ba6, task T1: the TEST-AUTHOR agent added an
// implementation-file mirror (outside t.tests) to make its own test pass,
// so the red gate correctly refused the task but reported a confusing
// "declared test was green" blocker instead of the real defect. Never trust
// the test author's own report of what it touched -- mechanically check,
// the same `git status --porcelain` pattern as captureGitSha, on Haiku.
const SCOPE_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    ran: { type: 'boolean', description: 'true only if the command actually executed' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'repo-root-relative path' },
          tracked: { type: 'boolean', description: 'false ONLY for a "??" (untracked) status line' },
        },
        required: ['path', 'tracked'],
      },
    },
  },
  required: ['ran', 'files'],
}
const SCOPE_REVERT_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'number', description: '0 only if every listed path was actually reverted or deleted' },
    reverted: { type: 'array', items: { type: 'string' } },
  },
  required: ['exitCode', 'reverted'],
}
// E9: paths the ENGINE ITSELF owns -- every run's own artifact directory
// (spec.md, build-plan.md, test-plan.md, RESUME.md, phases/, tasks/) plus
// the run-wide bookkeeping files that live one level up (agent-log.jsonl,
// cost-ledger.jsonl, approach-rotation.json) -- all under '.claude/pipeline/'.
// Real incident 2026-09-15 (Lite L2): a test-author touched its OWN run's
// artifact dir and agent-log.jsonl; enforceTestAuthorScope had no notion of
// "engine bookkeeping, not a scope violation" and flagged both as untracked
// + unplanned, then its remediation DELETED the run's own spec/build-plan/
// test-plan/RESUME.md -- every later task then had nothing to read and 9
// tasks cascaded to blocked. These paths must never be flagged, never sent
// to remediation, and never deleted, no matter what touches them.
// Normalised with normPath so '\\' and './' spellings all match the same way
// normPath already makes every other comparison in this file spelling-proof.
const ENGINE_OWNED_PATH_PREFIXES = [
  '.claude/pipeline/',
  ...(runDir ? [normPath(runDir).replace(/\/+$/, '') + '/'] : []),
].map(normPath)
function isEngineOwnedPath(p) {
  const n = normPath(p)
  return ENGINE_OWNED_PATH_PREFIXES.some((prefix) => n === prefix.slice(0, -1) || n.startsWith(prefix))
}
function scopeCheckPrompt() {
  return 'Run `git status --porcelain` from the repo root and report every changed or untracked file as a repo-root-relative path: tracked:false ONLY for a line starting "??", tracked:true for every other status line. Report ran:true only if the command actually executed.'
}
const UNTRACKED_SNAPSHOT_SCHEMA = {
  type: 'object',
  properties: { ran: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } } },
  required: ['ran', 'files'],
}
// E9, rule 2: captures the untracked-file set BEFORE a test-author call runs,
// the same "real git read, never the agent's own account" principle E7's
// captureMainFingerprint uses. enforceTestAuthorScope's remediation is only
// ever allowed to delete an UNTRACKED path that is NEW in this task's own
// after-snapshot (i.e. absent here) -- an untracked path already present
// before the agent ran is pre-existing content nobody may delete, no matter
// whose scope it falls outside. Engine-owned paths are stripped here too, so
// they never need to round-trip through this snapshot at all. Fail-safe: a
// dead/unreadable agent returns null, and callers must then treat every
// untracked path as "unknown, therefore not provably new" -- never as new.
async function captureUntrackedSnapshot(label) {
  const res = await askAgent(
    'Run `git status --porcelain --untracked-files=all` from the repo root. Report ran:true only if the command actually executed (an empty result still counts as executed), and files = every line that starts "??", with that prefix stripped, as repo-root-relative paths.',
    { label, phase: 'Author tests', model: M.haiku, effort: CFG.effort.baseline, schema: UNTRACKED_SNAPSHOT_SCHEMA },
  )
  if (!res || !res.ran || !Array.isArray(res.files)) return null
  return res.files.filter((f) => f && !isEngineOwnedPath(f))
}
// E9, rule 2: `items` are pre-classified {path, action} -- action 'checkout'
// for a TRACKED violation (always safe: HEAD's own content IS the
// pre-existing content), action 'delete' for an UNTRACKED violation this
// engine has already mechanically confirmed is NEW (absent from the
// before-snapshot). A path classified 'blocked-only' by the caller is never
// included here at all -- it is reported as a finding and left untouched.
function scopeRevertPrompt(items) {
  return [
    'Exactly these path(s) must come OUT of the working tree -- they were edited outside their task\'s declared scope. Handle ONLY the path(s) listed below, each EXACTLY as instructed, and touch nothing else:',
    ...items.map((v) => '- ' + v.path + ' -- ' + (v.action === 'checkout'
      ? 'TRACKED: run `git checkout -- "' + v.path + '"`.'
      : 'UNTRACKED and already confirmed new (did not exist before this task\'s agent ran): delete this ONE file directly (a single-file delete, never a directory or recursive delete).')),
    'Before acting on any path, run `git ls-files -- "<path>"` to confirm its tracked state matches what is listed above (non-empty output = tracked, empty = untracked). If a path\'s real state contradicts its listed action, STOP for that path only, change nothing, and report it in `reverted` as "<path> (tracked-state mismatch, skipped)" -- never guess or fall back to the other action.',
    'NEVER use `git reset`, `git clean`, `git stash`, or any directory/recursive delete for this -- uncommitted work from this run and from OTHER tasks lives elsewhere in this shared tree and those would destroy it.',
    'Report exitCode 0 only if every listed path was actually handled as instructed (checked out, deleted, or explicitly skipped on a mismatch), and reverted with the paths you actually handled.',
  ].join('\n')
}
// Runs after every test-author call (initial AND remediation), before the
// red-check reads the result. Returns null when the author stayed in scope
// (the common case, and fail-safe on a dead/unreadable scope-check agent --
// never block a task on this guard's own failure). On a violation, only the
// SAFE-TO-ACT-ON offending paths are reverted so the red gate that follows
// sees an honest tree, and a blocker finding is returned for the caller to
// attach either way.
//
// PARALLEL-WAVE HAZARD: several tasks' agents run concurrently in the SAME
// worktree (buildWaves groups independent tasks into one wave), so a plain
// `git status --porcelain` at this moment can show OTHER in-flight tasks'
// own implementation edits too -- not just this test author's. Attributing
// every changed/untracked path to THIS task and reverting all of them would
// destroy a sibling task's real work. So the violation set is deliberately
// narrow and never touches a path that belongs to another task's plan:
//   1. any changed/untracked path inside THIS task's own t.files (its own
//      implementation set -- unambiguously this test author's doing), plus
//   2. any UNTRACKED path that is new AND not planned by ANYONE (not in
//      t.tests, and not in any task's files/tests across the whole run) --
//      a stray file nobody's plan accounts for.
// A tracked, modified path that belongs to another task's files/tests is
// never flagged or reverted here, even if it happens to also fail rule 2's
// "not in t.tests" test -- it is excluded by rule 1 requiring t.files, and
// rule 2 applies only to untracked paths. E9 layers two more restrictions on
// top: an ENGINE-OWNED path (see isEngineOwnedPath) is never even considered
// a violation, and an UNTRACKED violation is only ever DELETED when
// `beforeUntracked` (this task's own pre-agent-call snapshot) mechanically
// proves it is new -- a pre-existing untracked path the agent merely touched
// is reported as a blocker and left on disk, never deleted (rule 3: when
// nothing is left that remediation may safely act on, the task still blocks,
// the run still continues, and the sibling/dependent handling is unchanged).
async function enforceTestAuthorScope(t, label, beforeUntracked) {
  const ownFiles = new Set(t.files || [])
  const ownTests = new Set(t.tests || [])
  const plannedAnywhere = new Set()
  for (const other of tasks) {
    for (const f of other.files || []) plannedAnywhere.add(f)
    for (const f of other.tests || []) plannedAnywhere.add(f)
  }
  // null means the before-snapshot itself failed (dead/unreadable agent) --
  // fail-safe means "cannot prove new", i.e. isNew must default to false.
  const beforeSet = Array.isArray(beforeUntracked) ? new Set(beforeUntracked.map(normPath)) : null
  const isNew = (p) => !!beforeSet && !beforeSet.has(normPath(p))
  const scope = await askAgent(scopeCheckPrompt(), { label: label + ':scope', phase: 'Author tests', model: M.haiku, effort: CFG.effort.baseline, schema: SCOPE_CHECK_SCHEMA })
  if (!scope || !scope.ran || !Array.isArray(scope.files)) return null
  const violations = []
  for (const f of scope.files) {
    if (!f || !f.path) continue
    if (isEngineOwnedPath(f.path)) continue
    let rule = null
    if (ownFiles.has(f.path)) rule = 'in this task\'s own implementation files (t.files)'
    else if (!f.tracked && !ownTests.has(f.path) && !plannedAnywhere.has(f.path)) rule = 'untracked and not in any task\'s files/tests -- unplanned'
    if (!rule) continue
    if (f.tracked) violations.push({ path: f.path, rule, action: 'checkout' })
    else if (isNew(f.path)) violations.push({ path: f.path, rule, action: 'delete' })
    else violations.push({ path: f.path, rule, action: 'blocked-only', note: 'untracked but present before this task\'s agent ran -- reported, never deleted' })
  }
  if (!violations.length) return null
  const actable = violations.filter((v) => v.action !== 'blocked-only')
  const blockedOnly = violations.filter((v) => v.action === 'blocked-only')
  // Rule 3: nothing actable (every violation is pre-existing untracked
  // content) -- do not even call the remediation agent; there is nothing it
  // may safely do. The task still blocks below.
  const revert = actable.length
    ? await askAgent(scopeRevertPrompt(actable), { label: label + ':scope-revert', phase: 'Author tests', model: M.haiku, effort: CFG.effort.baseline, schema: SCOPE_REVERT_SCHEMA })
    : null
  return {
    blockerFindings: [
      {
        file: '(scope)',
        severity: 'blocker',
        phase: 'Author tests',
        summary: 'test author touched non-test files: ' + violations.map((v) => v.path).join(', '),
        detail: 'Task ' + t.id + '\'s declared tests are ' + JSON.stringify(t.tests || []) +
          '; per-path rule matched: ' + violations.map((v) => v.path + ' (' + v.rule + ')').join('; ') + '. ' +
          (actable.length
            ? (revert && revert.exitCode === 0
                ? 'Reverted to HEAD / deleted before the red gate ran: ' + JSON.stringify(revert.reverted || actable.map((v) => v.path)) + '.'
                : 'Revert attempt did NOT confirm success (exitCode=' + (revert && revert.exitCode) + ') -- treat the tree as suspect.')
            : 'Nothing here was safe to revert -- every violating path is pre-existing untracked content this task\'s agent touched but did not create; ') +
          (blockedOnly.length
            ? ' Pre-existing untracked content this task\'s agent also touched is left in place and never deleted: ' + JSON.stringify(blockedOnly.map((v) => v.path)) + '.'
            : ''),
      },
    ],
  }
}
// ---------- E7: main-checkout workdir guard + implement liveness ----------
// Real launch 2026-09-15 (Lite lane): REPO_NOTE's "cd into workdir" is
// advisory text only -- two implementer agents ignored it and edited the
// MAIN checkout (C:\ClaudeCode\routeflow) while their workdir was a
// worktree (...\.claude\worktrees\rf-lite-L1); their tasks then stalled
// with only brief.md written, and nothing detected either failure. Two
// mechanical guards, same "never trust the agent's own account, check via a
// real git read" principle as enforceTestAuthorScope above:
//   1. withWorkdirGuard fingerprints the MAIN checkout (HEAD sha + a scoped
//      `git status --porcelain`) before and after any implement/test-author/
//      fix agent call, and flags a violation if it moved while workdir is a
//      SEPARATE worktree. Skipped entirely when workdir IS the main
//      checkout (nothing to compare against), and fail-safe like the scope
//      guard: a dead/unreadable fingerprint agent never blocks a task on
//      the GUARD's own failure -- only a CONFIRMED drift does.
//   2. checkImplementLiveness catches the OTHER half of the same incident:
//      an implementer that reports a non-blocked status but changed nothing
//      and never wrote its report.md. Mechanically confirmed (report.md
//      existence + a real `git status --porcelain` count), never trusted
//      off the self-reported filesChanged array alone -- an agent confused
//      about its own cwd cannot be trusted to accurately self-report an
//      empty change either.
function normFsPath(p) {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
const MAIN_DIR_SCHEMA = { type: 'object', properties: { ran: { type: 'boolean' }, dir: { type: 'string' } }, required: ['ran', 'dir'] }
const FINGERPRINT_SCHEMA = { type: 'object', properties: { ran: { type: 'boolean' }, sha: { type: 'string' }, status: { type: 'string' } }, required: ['ran', 'sha', 'status'] }
const LIVENESS_SCHEMA = { type: 'object', properties: { ran: { type: 'boolean' }, reportExists: { type: 'boolean' }, changedCount: { type: 'number' } }, required: ['ran', 'reportExists', 'changedCount'] }
// Memoized for the whole run -- workdir/its main checkout never change mid-run.
let _mainCheckoutDirPromise = null
async function mainCheckoutDir() {
  if (!workdir) return null
  if (!_mainCheckoutDirPromise) {
    _mainCheckoutDirPromise = (async () => {
      const res = await askAgent(
        'Run `git -C "' + workdir + '" rev-parse --path-format=absolute --git-common-dir` and report its single output line as dir (the absolute .git/common directory), and ran:true only if the command actually executed.',
        { label: 'workdir-guard:main-dir', phase: 'Workdir guard', model: M.haiku, effort: CFG.effort.baseline, schema: MAIN_DIR_SCHEMA },
      )
      if (!res || !res.ran || !res.dir) return null
      // The main checkout root is the PARENT of that .git/common dir, for
      // both an ordinary checkout (dir = "<root>/.git") and a worktree
      // (--git-common-dir also resolves to the MAIN checkout's ".git").
      return res.dir.replace(/[\\/]+[^\\/]+[\\/]*$/, '')
    })()
  }
  return _mainCheckoutDirPromise
}
async function captureMainFingerprint(main, label) {
  const res = await askAgent(
    'Run `git -C "' + main + '" rev-parse HEAD` and then `git -C "' + main + '" status --porcelain=v1 -- apps packages scripts .github`. Report sha as the first command\'s single output line, status as the exact second command\'s stdout (empty string if it printed nothing), and ran:true only if both commands actually executed.',
    { label, phase: 'Workdir guard', model: M.haiku, effort: CFG.effort.baseline, schema: FINGERPRINT_SCHEMA },
  )
  return res && res.ran ? { sha: res.sha, status: res.status } : null
}
// Wraps a file-touching agent call (implement/test-author/fix). `call` is a
// thunk making the real askAgent(...) call. Returns { response, violation }:
// `response` is always the real call's result, untouched; `violation` is a
// ready-to-attach blockerFinding, or null when the guard does not apply
// (no workdir, or workdir IS the main checkout) or found no drift.
async function withWorkdirGuard(t, label, call) {
  // E8: an agent that ends its turn without calling StructuredOutput can make
  // the underlying agent()/thunk REJECT instead of resolving to null. Every
  // file-touching agent call in this engine (test-author, implement,
  // docs-implement, every fix executor) routes through this one function, so
  // catching that rejection HERE and folding it into the SAME null-response
  // contract every stage already tolerates (`red || {...}`, `impl ? impl.status
  // : '(dead agent)'`) is enough to stop a non-compliant agent from crashing
  // the whole run instead of just blocking its one task. Never swallowed
  // silently -- logged so the failure is still visible in the run's console.
  const safeCall = async () => {
    try {
      return await call()
    } catch (e) {
      console.log('[' + label + '] agent call threw -- treating as a dead/declined agent: ' + (e && e.message))
      return null
    }
  }
  const main = await mainCheckoutDir()
  if (!main || normFsPath(main) === normFsPath(workdir)) return { response: await safeCall(), violation: null }
  const before = await captureMainFingerprint(main, label + ':guard-before')
  const response = await safeCall()
  if (!before) return { response, violation: null }
  const after = await captureMainFingerprint(main, label + ':guard-after')
  if (!after || (after.sha === before.sha && after.status === before.status)) return { response, violation: null }
  const beforeLines = new Set((before.status || '').split('\n').filter(Boolean))
  const changed = (after.status || '').split('\n').filter((l) => l && !beforeLines.has(l))
  return {
    response,
    violation: {
      file: '(workdir)',
      severity: 'blocker',
      phase: 'Workdir guard',
      summary: 'Task ' + t.id + '\'s agent (' + label + ') changed the MAIN checkout at "' + main + '" while its workdir is the separate worktree "' + workdir + '" -- ' +
        (changed.length ? 'changed paths: ' + changed.join(', ') : 'HEAD moved ' + before.sha + ' -> ' + after.sha) + '.',
      detail: 'before: ' + JSON.stringify(before) + '; after: ' + JSON.stringify(after),
    },
  }
}
function livenessCheckPrompt(t) {
  return 'Check whether "' + taskDir(t.id) + '/report.md" exists (reportExists), and run `git -C "' + workdir + '" status --porcelain` (never a bare git relying on your cwd) to count changed/untracked entries (changedCount, an integer). Report ran:true only if both checks actually executed.'
}
// Called only when the implementer's OWN report already looks empty
// (non-blocked status, no filesChanged) -- a mechanical second opinion
// before trusting that as "nothing to do" rather than "silently stalled".
// Fail-safe: a dead/unreadable liveness agent returns null (no block); only
// a CONFIRMED empty workdir (no report.md AND zero git-status entries)
// blocks the task.
async function checkImplementLiveness(t, impl, label, phaseName) {
  if (!impl || impl.status === 'blocked') return null
  if (Array.isArray(impl.filesChanged) && impl.filesChanged.length > 0) return null
  const liveness = await askAgent(livenessCheckPrompt(t), { label: label + ':liveness', phase: phaseName, model: M.haiku, effort: CFG.effort.baseline, schema: LIVENESS_SCHEMA })
  if (!liveness || !liveness.ran) return null
  if (liveness.reportExists || liveness.changedCount > 0) return null
  return {
    file: '(implement)',
    severity: 'blocker',
    phase: phaseName,
    summary: 'Task ' + t.id + '\'s agent (' + label + ') reported status ' + impl.status + ' but left no changed files and no report.md -- no work in workdir.',
    detail: JSON.stringify({ impl, liveness }),
  }
}
// Fix round 1, finding 2/9: the fix loop needs a real commit boundary per
// round to scope a re-review pack to just that round's diff -- every fix
// executor (rounds 1-2, and the round-3/4 designer-executor) is told to
// commit its own change, the same pattern the rest of this rebuild's
// implementers use.
const COMMIT_NOTE = 'Commit your change when you are done (a small, scoped commit) so this round\'s exact diff can be captured and re-reviewed -- never leave it uncommitted.'
const REREVIEW_SCHEMA = {
  type: 'object',
  properties: {
    perFinding: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          status: { type: 'string', enum: ['ADDRESSED', 'NOT ADDRESSED'] },
          evidence: { type: 'string', description: 'file:line evidence for the verdict -- never the fixer\'s own say-so' },
        },
        required: ['key', 'status', 'evidence'],
      },
    },
    newFindings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          scenario: { type: 'string' },
        },
        required: ['severity', 'file', 'summary', 'scenario'],
      },
    },
  },
  required: ['perFinding', 'newFindings'],
}

// ---------- A10: bugfix task type schemas ----------
// root-cause: adapted from the plan's Task 10 literal shape.
const ROOT_CAUSE_SCHEMA = {
  type: 'object',
  properties: {
    reproduced: { type: 'boolean', description: 'true ONLY if you actually observed the bug happen on the current tree, not merely read code and inferred it would' },
    causeConfirmed: { type: 'boolean', description: 'true ONLY if the brief\'s named cause is what actually produces the wrong value -- false if you reproduced a DIFFERENT bug, or the named cause is not what is happening' },
    wrongValueObserved: { type: 'string', description: 'the actual wrong value/output you saw, verbatim' },
    note: { type: 'string' },
  },
  required: ['reproduced', 'causeConfirmed', 'wrongValueObserved', 'note'],
}
// revert-probe: adapted from pipeline.js.bak-2026-09-12 @1646 (revertProbePrompt)
// and its MUTATION_SCHEMA @896 -- trimmed to the fields this rebuild's
// in-script checksum comparison actually reads (preHash/postHash dropped:
// Baseline's own manifest digest is the "before" record here, and the
// dedicated checksum:after agent below is the "after" one -- neither needs
// the probe agent's own hash claim, which is never trusted as sole evidence).
const REVERT_PROBE_SCHEMA = {
  type: 'object',
  properties: {
    caught: { type: 'boolean', description: 'true ONLY if the named test FAILED on an assertion once the fix was reverted' },
    restored: { type: 'boolean', description: 'true ONLY if you are confident the file is byte-identical to the backup you took before reverting -- an independent checksum agent verifies this afterward, so never claim it without having actually compared' },
    evidence: { type: 'string', description: 'the assertion failure message, or the output proving the test is blind to the fix' },
    backupPath: { type: 'string', description: 'absolute path of the backup, in the OS temp directory' },
    fallback: { type: 'string', description: 'set to the exact string "untracked" ONLY when the file had no committed HEAD version to revert to; empty string otherwise' },
  },
  required: ['caught', 'restored', 'evidence'],
}
// checksum:after -- adapted from pipeline.js.bak-2026-09-12 @1016
// (CHECKSUM_SCHEMA), but git hash-object (matching MANIFEST_SCHEMA's own
// digest field, @495 above) instead of sha256sum -- so the in-script
// comparison below is apples to apples against the Baseline manifest's
// per-file `digest`.
const CHECKSUM_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'the path exactly as it was given to you' },
          digest: { type: 'string', description: '`git hash-object <file>` digest, lowercase hex; the exact string "unreadable" if the file could not be read' },
        },
        required: ['file', 'digest'],
      },
    },
  },
  required: ['files'],
}
// sibling sweep -- adapted from pipeline.js.bak-2026-09-12 @975/@995
// (SIBLING_HITS_SCHEMA / SIBLING_VERDICT_SCHEMA), verbatim shape.
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
    truncated: { type: 'array', items: { type: 'string' }, description: 'the patterns whose hit list had to be capped; empty when none was' },
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
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'], description: 'the severity this hit deserves if it is a defect; "minor" for the other verdicts' },
          evidence: { type: 'string', description: 'ONE sentence: for "defect" the concrete failure scenario; for "same-class-but-guarded" the guard that prevents it; for "unrelated" why the match is incidental' },
        },
        required: ['index', 'verdict', 'severity', 'evidence'],
      },
    },
  },
  required: ['verdicts'],
}

// ---------- A10b: ui-verify task type schema ----------
// Adapted from pipeline.js.bak-2026-09-12 @1076-1101 (UI_EVIDENCE_SCHEMA):
// what the driver hands the judge -- facts per flow per viewport, no
// verdicts. Same required shape verbatim.
const UI_EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    completed: { type: 'boolean', description: 'true ONLY if every listed flow was driven at every listed viewport -- a flow that could not be driven is reported with status "blocked", and this stays false' },
    specPath: { type: 'string', description: 'repo-relative path of the Playwright spec you wrote and ran; empty if a browser-driving fallback was used' },
    flows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          flow: { type: 'string' },
          viewport: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
          screenshot: { type: 'string', description: 'path of the screenshot taken at the end of this flow at this viewport; empty if blocked' },
          assertions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, passed: { type: 'boolean' } }, required: ['text', 'passed'] } },
          consoleErrors: { type: 'array', items: { type: 'string' }, description: 'every console error or unhandled rejection captured during this flow, verbatim' },
          networkFailures: { type: 'array', items: { type: 'string' }, description: 'every request that 4xx/5xx, aborted or timed out: method, URL, status' },
          a11y: { type: 'array', items: { type: 'string' }, description: 'accessibility facts observed, stated as fact -- never a verdict' },
          notes: { type: 'string' },
        },
        required: ['flow', 'viewport', 'status', 'screenshot', 'assertions', 'consoleErrors', 'networkFailures', 'a11y', 'notes'],
      },
    },
    processesStopped: { type: 'boolean', description: 'true ONLY if every server, browser and port you started is stopped' },
  },
  required: ['completed', 'specPath', 'flows', 'processesStopped'],
}

function briefPrompt(t) {
  return [
    'Run this exact command from the repo root, then report its result:',
    scriptCmd('task-brief.mjs') + ' --plan ' + (_args.buildPlanPath || '(no build plan supplied)') + ' --task ' + t.id + ' --out ' + taskDir(t.id) + '/brief.md',
    'The script prints its result as the LAST stdout line: one JSON object {out, bytes, truncated, sections, exitCode}. Report exactly that object -- do not paraphrase or re-derive it. Report the process exit code as exitCode: it must be 0 and out must be the brief.md path actually written, or this call failed.',
  ].join('\n')
}
// Fix 1/Fix 2 (real smoke-run finding): task-brief.mjs shares
// review-pack.mjs's cwd-dependent invocation risk, and this stage's script
// result previously had no exitCode field -- a nonzero exit (or a missing
// scriptsDir, which makes the command unbuildable in the first place) was
// silently accepted as a real brief.md path. Mirrors packStage's exitCode
// check and blocker shape exactly: a task must never be handed a brief path
// that was never actually written.
async function briefStage(t) {
  if (!scriptsDir) {
    return {
      ...t,
      blocked: true,
      blockerFindings: [
        {
          file: '(brief)',
          severity: 'blocker',
          phase: 'Author tests',
          summary: 'Task ' + t.id + ' cannot run task-brief.mjs -- no scriptsDir was supplied to this run.',
          detail: 'args.scriptsDir (the absolute path to dev-pipeline\'s scripts directory) is required so this invocation does not depend on the invoking agent\'s cwd, which is always the target workdir -- never dev-pipeline\'s own directory -- in a real run.',
        },
      ],
    }
  }
  const brief = await askAgent(briefPrompt(t), { label: 'brief:' + t.id, phase: 'Author tests', model: M.haiku, effort: CFG.effort.baseline, schema: SCRIPT_RESULT_SCHEMA })
  if (!brief || brief.exitCode !== 0 || !brief.out) {
    return {
      ...t,
      blocked: true,
      blockerFindings: [
        {
          file: '(brief)',
          severity: 'blocker',
          phase: 'Author tests',
          summary: 'Task ' + t.id + '\'s task-brief.mjs run did not produce a brief.md -- downstream stages must never be handed a path that was never actually written.',
          detail: brief ? ('exitCode=' + brief.exitCode + ' out=' + JSON.stringify(brief.out || '')) : 'the brief-building agent returned nothing',
        },
      ],
    }
  }
  return { ...t, briefPath: brief.out }
}

function testAuthorPrompt(t) {
  return [
    'You are the TEST AUTHOR for task ' + t.id + '. Read the task brief at "' + (t.briefPath || taskDir(t.id) + '/brief.md') + '" for exactly what to test.',
    'Write the tests named in this task\'s tests list, and ONLY those tests -- no implementation code:',
    ...(t.tests || []).map((f) => '- ' + f),
    t.type === 'repro-test'
      ? 'This is a REPRO-TEST task: assert the CORRECT behavior. The current (buggy) tree must fail it -- your failure output must literally contain the bug\'s own wrong value, "' + (t.wrongValue || '') + '", not just fail for any reason.'
      : 'The behavior under test does not exist yet, so every test you write MUST fail right now.',
    'Run them and report the runner output verbatim (every failing test name, its failure message, and the pass/fail/skip counts) as results[].output. Report ran:true only if the command(s) you ran actually executed (a failing run still counts as executed).',
    'Then write "' + taskDir(t.id) + '/tests-report.md" containing that same observed RED output.',
    'Do NOT implement the behavior. Do NOT modify any file outside this task\'s tests list.',
    'SCOPE, non-negotiable: you may create or edit ONLY the files listed in `tests` above. You must not create, edit, or delete any other file -- in particular none of this task\'s implementation `files`, and nothing under packages/. If a test cannot be written without an implementation symbol that does not exist yet, write the test against the symbol\'s name anyway and let it fail on import/undefined -- that IS the red state. Report blockedOn (in notes/deviations if your schema has no such field) instead of implementing it yourself.',
  ].join('\n')
}
async function testAuthorStage(t) {
  if (!profile.separateTestAuthor) return { ...t, redRun: { ran: false, results: [], skipped: 'lean-profile' } }
  // E9, rule 2: snapshot BEFORE the author touches anything, so the scope
  // guard below can mechanically tell a file the author just created (safe
  // to delete on a violation) from one that already existed (never deleted).
  const beforeUntracked = await captureUntrackedSnapshot('tests:' + t.id + ':scope-before')
  const { response: red, violation } = await withWorkdirGuard(t, 'tests:' + t.id, () =>
    askAgent(testAuthorPrompt(t), { label: 'tests:' + t.id, phase: 'Author tests', model: M.sonnet, effort: CFG.effort.testAuthor, schema: RED_RUN_SCHEMA }),
  )
  if (violation) return { ...t, redRun: red || { ran: false, results: [] }, blocked: true, blockerFindings: [violation] }
  const scopeBlock = await enforceTestAuthorScope(t, 'tests:' + t.id, beforeUntracked)
  if (scopeBlock) return { ...t, redRun: red || { ran: false, results: [] }, blocked: true, blockerFindings: scopeBlock.blockerFindings }
  return { ...t, redRun: red || { ran: false, results: [] } }
}

function redCheckPrompt(t, redRun) {
  return [
    'You are the RED-GATE check for task ' + t.id + '. The task\'s declared test files are:',
    ...(t.tests || []).map((f) => '- ' + f),
    'Below is the test author\'s reported run of those NEW tests, which must all have failed on an assertion (not errored, skipped, or passed):',
    JSON.stringify(redRun),
    t.type === 'repro-test'
      ? 'This is a REPRO-TEST task: the failure output must ALSO literally contain the bug\'s own wrong value, "' + (t.wrongValue || '') + '" -- a structurally red test whose output never mentions that string does not prove this test catches THIS bug. Note that gap explicitly if it applies.'
      : '',
    taskIntroducesObservable(t)
      ? 'This task INTRODUCES the observable its tests assert on (e.g. a CLI line or log message that does not exist before Implement) -- a "feature absent" failure (an error/import-undefined outcome, or any other non-pass outcome) is EXPECTED and acceptable here, not a defect to remediate. The only thing that still blocks is a test that actually PASSED -- report that outcome accurately as "passed" if it happened, never soften it.'
      : '',
    'For each named test decide its outcome. structurallyRed is true ONLY if every one is assertion-failure. List every problem in blockers, and if not structurallyRed, say in remediation exactly what the test author must fix (syntax, import, fixture, config -- never the assertion itself).',
  ].filter(Boolean).join('\n')
}
function redRemediationPrompt(t, audit, behavioralGap) {
  return [
    'Your tests for task ' + t.id + ' did not pass the ' + (behavioralGap ? 'BEHAVIORAL' : 'structural') + ' RED check.',
    'Problems: ' + JSON.stringify((audit && audit.blockers) || []),
    'Remediation requested: ' + ((audit && audit.remediation) || '(none given)'),
    behavioralGap
      ? 'The test(s) fail on an assertion, but the failure output never literally contained the bug\'s own wrong value, "' + (t.wrongValue || '') + '". Strengthen the assertion or its failure message so the output includes that exact string -- do not weaken any other assertion.'
      : 'Fix ONLY the structural problem (syntax, import, fixture, config) so each test actually runs and fails on its own assertion. Do not weaken any assertion.',
    'Re-run and report the same shape as before.',
    'SCOPE, non-negotiable: you may create or edit ONLY the files listed in `tests` for this task. You must not create, edit, or delete any other file -- in particular none of `files` (the implementation set) and nothing under packages/. If a test cannot be written without an implementation symbol, write the test against the symbol name and let it fail on import/undefined -- that IS the red state; report blockedOn instead of implementing.',
  ].join('\n')
}
// Fix round 1, finding 8: the auditor's own `structurallyRed` claim is never
// trusted alone -- it is corroborated mechanically: the red run actually
// executed, at least one test was actually named, and every named test's
// own per-test outcome is assertion-failure. A lying or confused auditor
// (structurallyRed:true over an empty tests[], or over a run that never
// actually executed) cannot pass a test that errored, was never collected,
// or was skipped.
function isStructurallyRed(redRun, audit) {
  const ran = !!(redRun && redRun.ran)
  const tests = audit && Array.isArray(audit.tests) ? audit.tests : []
  return ran && tests.length > 0 && tests.every((o) => o && o.outcome === 'assertion-failure')
}
// E4: true when the task's own declaration says it INTRODUCES the observable
// its tests assert on (a not-yet-existing CLI line, log message, etc.), so
// "feature absent" (import/undefined, or any other non-pass outcome) is the
// only possible pre-implementation RED state -- accept either the explicit
// boolean or the literal token in the inline brief text.
function taskIntroducesObservable(t) {
  return t.introducesObservable === true || (typeof t.brief === 'string' && t.brief.includes('INTRODUCES-OBSERVABLE'))
}
// E4: the structural-RED-accepted path for an introducesObservable task --
// every declared test must have actually run and NONE may have passed
// (assertion-failure, error/import-undefined, or not-run all count as
// "failed" here; a single passed test still blocks, same as any other
// task -- that is the T1 case the scope guard also prevents).
function isStructuralRedAccepted(t, redRun, audit) {
  if (!taskIntroducesObservable(t)) return false
  const ran = !!(redRun && redRun.ran)
  const tests = audit && Array.isArray(audit.tests) ? audit.tests : []
  return ran && tests.length > 0 && tests.every((o) => o && o.outcome !== 'passed')
}
// A10 (repro-test): a mechanical, script-level check -- never trust the
// auditor's prose about whether the wrong value showed up. The RED check for
// this type is BEHAVIORAL, not merely structural: the failure output must
// literally contain t.wrongValue (adapted from pipeline.js.bak-2026-09-12's
// RED-check-area logic around @1646, per the plan's own wording).
function isBehaviorallyRed(redRun, wrongValue) {
  if (!wrongValue) return true // nothing declared to check against
  const results = redRun && Array.isArray(redRun.results) ? redRun.results : []
  return results.some((r) => r && typeof r.output === 'string' && r.output.includes(wrongValue))
}
async function redCheckStage(t) {
  if (t.blocked) return t
  if (!profile.separateTestAuthor) return t
  const wantsBehavioral = t.type === 'repro-test'
  let redRun = t.redRun || { ran: false, results: [] }
  let audit = await askAgent(redCheckPrompt(t, redRun), { label: 'red-check:' + t.id, phase: 'Red gate', model: M.haiku, effort: CFG.effort.redCheck, schema: RED_AUDIT_SCHEMA })
  let structOk = isStructurallyRed(redRun, audit)
  let behaviorOk = wantsBehavioral ? isBehaviorallyRed(redRun, t.wrongValue) : true
  // A14: attempts=1|2 is retained on the task so the run-level redGate
  // summary can sum real per-task attempt counts instead of guessing.
  if (structOk && behaviorOk) return { ...t, redRun, redAudit: audit, redAttempts: 1, behaviorallyRed: wantsBehavioral ? true : undefined }
  // E4: a task that declares introducesObservable never gets a "properly"
  // structurallyRed audit -- its tests fail on the observable's absence
  // (import/undefined, not an assertion), which isStructurallyRed correctly
  // refuses. Classify that as an ACCEPTED structural RED instead of routing
  // into remediation, which can never fix a "feature absent" failure. Still
  // blocks (falls through below) if any declared test actually passed.
  if (isStructuralRedAccepted(t, redRun, audit)) {
    console.log('[' + t.id + '] structural RED accepted: the task introduces the observable')
    return {
      ...t,
      redRun,
      redAudit: { ...audit, structurallyRed: true, accepted: true, note: 'structural RED accepted: the task introduces the observable' },
      redAttempts: 1,
      structurallyRed: true,
      structuralRedAccepted: true,
      behaviorallyRed: wantsBehavioral ? true : undefined,
    }
  }
  // ONE test-author remediation attempt, then a hard blocker (brief D).
  // E9, rule 2: same before-snapshot discipline as the initial call above --
  // this remediation call gets its OWN before-snapshot, since it is a fresh
  // agent invocation that can create its own new untracked files.
  const beforeUntrackedRemediate = await captureUntrackedSnapshot('tests:' + t.id + ':remediate:scope-before')
  const remediated = await askAgent(redRemediationPrompt(t, audit, wantsBehavioral && structOk && !behaviorOk), { label: 'tests:' + t.id + ':remediate', phase: 'Author tests', model: M.sonnet, effort: CFG.effort.testAuthor, schema: RED_RUN_SCHEMA })
  redRun = remediated || redRun
  const scopeBlock = await enforceTestAuthorScope(t, 'tests:' + t.id + ':remediate', beforeUntrackedRemediate)
  if (scopeBlock) return { ...t, redRun, redAudit: audit, redAttempts: 2, blocked: true, blockerFindings: scopeBlock.blockerFindings }
  audit = await askAgent(redCheckPrompt(t, redRun), { label: 'red-check:' + t.id + ':r2', phase: 'Red gate', model: M.haiku, effort: CFG.effort.redCheck, schema: RED_AUDIT_SCHEMA })
  structOk = isStructurallyRed(redRun, audit)
  behaviorOk = wantsBehavioral ? isBehaviorallyRed(redRun, t.wrongValue) : true
  if (structOk && behaviorOk) return { ...t, redRun, redAudit: audit, redAttempts: 2, behaviorallyRed: wantsBehavioral ? true : undefined }
  if (isStructuralRedAccepted(t, redRun, audit)) {
    console.log('[' + t.id + '] structural RED accepted: the task introduces the observable')
    return {
      ...t,
      redRun,
      redAudit: { ...audit, structurallyRed: true, accepted: true, note: 'structural RED accepted: the task introduces the observable' },
      redAttempts: 2,
      structurallyRed: true,
      structuralRedAccepted: true,
      behaviorallyRed: wantsBehavioral ? true : undefined,
    }
  }
  return {
    ...t,
    redRun,
    redAudit: audit,
    redAttempts: 2,
    behaviorallyRed: wantsBehavioral ? false : undefined,
    blocked: true,
    blockerFindings: [
      {
        file: '(red-gate)',
        severity: 'blocker',
        phase: 'Red gate',
        summary: 'Task ' + t.id + '\'s tests never proved they can fail on an assertion' + (wantsBehavioral ? ' containing the bug\'s own wrong value' : '') + ', after one remediation attempt.',
        detail: JSON.stringify((audit && audit.blockers) || ['no red-check evidence -- the red-check agent died or was skipped, both attempts']) +
          (wantsBehavioral && structOk && !behaviorOk ? ' -- structurally red, but the failure output never contained the wrong value "' + t.wrongValue + '"' : ''),
      },
    ],
  }
}

// A10 (fix): a `fix` task authors no tests of its own -- it consumes the
// tests its `repro-test` dependency wrote (validateTasks already requires
// one exists among its ancestors). Look that ancestor up by walking
// dependsOn, so the implementer is told exactly which tests it must turn
// GREEN instead of reading an empty t.tests list.
function testsForImplementer(t) {
  if (t.type !== 'fix') return t.tests || []
  const reproTests = ancestorsOfType(t.id, tasksById, 'repro-test')
  return [].concat(...reproTests.map((rt) => rt.tests || []))
}
function implementPrompt(t) {
  const tests = testsForImplementer(t)
  return [
    'You are the IMPLEMENTER for task ' + t.id + '. Read the task brief at "' + (t.briefPath || taskDir(t.id) + '/brief.md') + '" and make the RED tests pass:',
    ...tests.map((f) => '- ' + f),
    t.type === 'fix' ? 'This is a FIX task: those tests belong to your repro-test dependency, not to you -- you author no tests of your own.' : '',
    'Files you own for this task:',
    ...(t.files || []).map((f) => '- ' + f),
    !profile.separateTestAuthor
      ? 'This run has no separate test author: write the tests yourself, run them once to confirm they FAIL first (paste that RED output), then implement and paste the GREEN output, both in report.md.'
      : 'The tests already exist and are RED. Implement the minimal correct change to make them pass -- do not weaken any assertion.',
    (verifyCommands.perRound || []).length ? 'Also run, scoped to this task\'s files where possible: ' + (verifyCommands.perRound || []).join(' ; ') : '',
    // Fix round 2, finding 2: without this, round 1's fix-base capture (at
    // the very start of the fix loop) still points at the pre-task commit --
    // the round-1 re-review pack then ends up diffing the ORIGINAL
    // implementation PLUS the round-1 fix together, even though its own
    // prompt tells the reviewer the pack scopes to ONLY the fix diff. Reuse
    // the exact fix-executor COMMIT_NOTE (not a new one) so a real commit
    // exists here too, before ANY fix-base capture happens for round 1.
    COMMIT_NOTE,
    'Write "' + taskDir(t.id) + '/report.md" with the GREEN evidence, the files you changed, and any deviation from the brief.',
  ].filter(Boolean).join('\n')
}
async function implementStage(t) {
  if (t.blocked) return t
  const high = isHighRisk(t)
  const model = M.sonnet // implementation is never Fable (ruling 2026-09-13)
  const effort = high ? CFG.effort.implementHigh : CFG.effort.implement
  // Fix round 2, finding 2: captured BEFORE the implementer runs (and,
  // per COMMIT_NOTE above, likely commits) so packStage's FIRST review has a
  // real pre-implement base to diff against -- `--base worktree` (git diff
  // HEAD) would otherwise go empty the moment the implementer's own commit
  // makes the working tree match HEAD.
  const implBaseSha = await captureGitSha('impl-base:' + t.id, 'Implement')
  const { response: impl, violation } = await withWorkdirGuard(t, 'impl:' + t.id, () =>
    askAgent(fableSafe(model, implementPrompt(t)), { label: 'impl:' + t.id, phase: 'Implement', model, effort, schema: IMPL_SCHEMA }),
  )
  if (violation) return { ...t, implBaseSha, implement: impl || { status: 'blocked', filesChanged: [], deviations: '', notes: '' }, blocked: true, blockerFindings: [violation] }
  // Fix round 1, finding 7: a blocked or dead implementer must become a task
  // blocker BEFORE pack/review ever run -- never review code that was never
  // actually written. 'partial' still proceeds (the reviewer judges it).
  if (!impl || impl.status === 'blocked') {
    return {
      ...t,
      implBaseSha,
      implement: impl || { status: 'blocked', filesChanged: [], deviations: '', notes: 'implementer agent returned nothing' },
      blocked: true,
      blockerFindings: [
        {
          file: '(implement)',
          severity: 'blocker',
          phase: 'Implement',
          summary: 'Task ' + t.id + '\'s implementer did not produce a working change -- status ' + (impl ? impl.status : '(dead agent)') + '.',
          detail: impl ? JSON.stringify(impl) : 'the implementer agent returned nothing',
        },
      ],
    }
  }
  // E7 layer 3: a non-blocked report with an empty footprint gets one more,
  // mechanical check before being trusted as real work.
  const liveBlock = await checkImplementLiveness(t, impl, 'impl:' + t.id, 'Implement')
  if (liveBlock) return { ...t, implBaseSha, implement: impl, blocked: true, blockerFindings: [liveBlock] }
  return { ...t, implBaseSha, implement: impl }
}

// ---------- A10 (fix): root-cause gate ----------
// validateTasks (A3) already blocks a `fix` with no `root-cause` ancestor at
// PLAN-VALIDATION time -- structural. This is the RUNTIME half the plan
// calls for: even a structurally valid fix must not proceed past its
// dependency until that dependency's OWN reported result says the bug is
// real. `resultsById` (populated by the wave loop, below) holds every
// already-finished task's result by id -- root-cause tasks always run in an
// earlier wave than their dependent fix (dependsOn ordering, A7), so the
// result is guaranteed to be there by the time this runs. Every stage after
// this one (implementStage, packStage, reviewStage, fixLoopStage) already
// early-returns on t.blocked, so setting it here is sufficient to stop the
// whole rest of the chain -- "the fix task ends in a blocked/open state, not
// silently proceed as if nothing happened."
async function fixGateStage(t) {
  if (t.type !== 'fix') return t
  const rcTasks = ancestorsOfType(t.id, tasksById, 'root-cause')
  const rcResults = rcTasks.map((rc) => resultsById.get(rc.id)).filter(Boolean)
  const confirmed = rcResults.length > 0 && rcResults.every((r) => r.rootCause && r.rootCause.reproduced === true && r.rootCause.causeConfirmed === true)
  if (confirmed) return t
  const detail = rcResults.length
    ? 'root-cause result(s): ' + JSON.stringify(rcResults.map((r) => r.rootCause))
    : 'no root-cause result is available for this fix\'s dependency -- it may itself have died, been skipped, or been blocked'
  const ruling = makeRuling(
    t.id,
    'blocked',
    'this fix\'s root-cause dependency did not confirm reproduced && causeConfirmed -- ' + detail,
    'implementing a fix for a bug that was never confirmed reproducible risks shipping a no-op change while the real defect ships unfixed',
  )
  return {
    ...t,
    blocked: true,
    status: 'open',
    clean: false,
    rulings: [ruling],
    blockerFindings: [
      {
        file: '(root-cause)',
        severity: 'blocker',
        phase: 'Implement',
        summary: 'Task ' + t.id + ' (fix) is blocked -- its root-cause dependency did not confirm reproduced && causeConfirmed.',
        detail,
      },
    ],
  }
}

// ---------- A10 (root-cause) ----------
function rootCausePrompt(t) {
  return [
    'You are the ROOT-CAUSE investigator for task ' + t.id + '. Read the task brief at "' + (t.briefPath || taskDir(t.id) + '/brief.md') + '" for the bug this run is about to fix.',
    'Reproduce the bug on the CURRENT tree with the smallest probe that shows it (a scratch script, a REPL call, or the smallest failing check you can run and immediately discard) -- do NOT implement a fix, and do not write a permanent test file here (that is the repro-test task\'s job).',
    'Confirm or refute the brief\'s NAMED cause: read the code path it points to and verify the wrong value it predicts actually appears.',
    'Report reproduced (true ONLY if you actually observed the bug happen, not merely read code and inferred it would), causeConfirmed (true ONLY if the brief\'s named cause is what actually produces the wrong value -- false if you reproduced a DIFFERENT bug, or the named cause is not what is happening), wrongValueObserved (the actual wrong value/output you saw, verbatim), and note.',
  ].join('\n')
}
// Fix round 1, finding 1: a root-cause task's OWN files/tests/risk are
// naturally empty (a pure investigation, per the plan and every fixture) --
// the real risk classification lives on its DEPENDENT `fix` task instead
// (dependsOn: [rootCauseId, reproTestId], often risk:'HIGH' for a real
// money/auth/tenancy bug). Without this, a HIGH-risk fix's root-cause
// investigation silently ran on Sonnet -- find any `fix` task that has this
// root-cause task as an ancestor and defer to isHighRisk() on THAT task
// (never reimplementing its HIGH/LOW merge here). `tasks` is the top-level
// validated array every stage already closes over (tasksById is built from
// it just above); no extra parameter needs threading through.
// Fix round 2, finding 1: the original check was `(ot.dependsOn ||
// []).includes(rcId)` -- a DIRECT edge only. A fix task that depends on this
// root-cause task through an intermediate task (fix -> repro-test ->
// root-cause, which validateTasks itself explicitly accepts as a valid
// ancestor chain) was invisible to it, so that fix's HIGH-risk classification
// never propagated back. Reuses ancestorIds() -- the SAME transitive
// dependsOn walk fixGateStage/validateTasks already use for this identical
// relationship -- instead of a second, direct-only mechanism. `.some()`
// promotes on ANY qualifying dependent fix, regardless of how many other
// dependents (direct or transitive) are LOW-risk.
function hasHighRiskDependentFix(rcId) {
  return tasks.some((ot) => ot.type === 'fix' && ancestorIds(ot.id, tasksById).has(rcId) && isHighRisk(ot))
}
async function rootCauseStage(t) {
  const high = isHighRisk(t) || hasHighRiskDependentFix(t.id)
  const model = high ? M.opus : M.sonnet // root cause = "what to write": Opus on HIGH (ruling 2026-09-13)
  const rc = await askAgent(fableSafe(model, rootCausePrompt(t)), { label: 'root-cause:' + t.id, phase: 'Implement', model, effort: CFG.effort.rootCause, schema: ROOT_CAUSE_SCHEMA })
  if (!rc) {
    return {
      ...t,
      blocked: true,
      status: 'open',
      clean: false,
      rootCause: null,
      blockerFindings: [
        {
          file: '(root-cause)',
          severity: 'blocker',
          phase: 'Implement',
          summary: 'Task ' + t.id + '\'s root-cause investigator died or was skipped -- no dependent fix can be safely gated.',
          detail: 'a dead root-cause agent must never read as confirmed -- every dependent fix stays blocked (fail-safe, matching the dead-manifest/dead-reviewer pattern used elsewhere in this engine)',
        },
      ],
    }
  }
  return { ...t, rootCause: rc }
}

// ---------- A10 (docs) ----------
function docsImplementPrompt(t) {
  return [
    'You are the IMPLEMENTER for docs task ' + t.id + '. Read the task brief at "' + (t.briefPath || taskDir(t.id) + '/brief.md') + '".',
    'Files you own for this task:',
    ...(t.files || []).map((f) => '- ' + f),
    'This is a DOCS task: there are no tests to write or pass. Make the documentation change the brief describes.',
    t.check ? 'Then run this exact check command and report its result verbatim in notes: ' + t.check : '',
    COMMIT_NOTE,
    'Write "' + taskDir(t.id) + '/report.md" with what you changed and any deviation from the brief.',
  ].filter(Boolean).join('\n')
}
async function docsImplementStage(t) {
  if (t.blocked) return t
  const high = isHighRisk(t)
  const model = M.sonnet // implementation is never Fable (ruling 2026-09-13)
  const effort = high ? CFG.effort.implementHigh : CFG.effort.implement
  const implBaseSha = await captureGitSha('impl-base:' + t.id, 'Implement')
  const { response: impl, violation } = await withWorkdirGuard(t, 'impl:' + t.id, () =>
    askAgent(fableSafe(model, docsImplementPrompt(t)), { label: 'impl:' + t.id, phase: 'Implement', model, effort, schema: IMPL_SCHEMA }),
  )
  if (violation) return { ...t, implBaseSha, implement: impl || { status: 'blocked', filesChanged: [], deviations: '', notes: '' }, blocked: true, blockerFindings: [violation] }
  if (!impl || impl.status === 'blocked') {
    return {
      ...t,
      implBaseSha,
      implement: impl || { status: 'blocked', filesChanged: [], deviations: '', notes: 'implementer agent returned nothing' },
      blocked: true,
      blockerFindings: [
        {
          file: '(implement)',
          severity: 'blocker',
          phase: 'Implement',
          summary: 'Docs task ' + t.id + '\'s implementer did not produce a working change -- status ' + (impl ? impl.status : '(dead agent)') + '.',
          detail: impl ? JSON.stringify(impl) : 'the implementer agent returned nothing',
        },
      ],
    }
  }
  const liveBlock = await checkImplementLiveness(t, impl, 'impl:' + t.id, 'Implement')
  if (liveBlock) return { ...t, implBaseSha, implement: impl, blocked: true, blockerFindings: [liveBlock] }
  return { ...t, implBaseSha, implement: impl }
}

function packPrompt(t) {
  // Fix round 1, finding 1: review-pack.mjs's --radius takes a [before,
  // after] context-line count PAIR, not a file list -- it auto-discovers
  // radius files itself from its own Call-Sites hits. Emit the flag only
  // when the task declares that exact numeric pair; otherwise omit it
  // entirely and let the script's own Call-Sites-derived radius stand on
  // its own (a valid, already-tested mode of that script).
  const r = Array.isArray(t.radius) ? t.radius : null
  const radiusFlag = r && r.length === 2 && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])) ? ' --radius ' + Number(r[0]) + ',' + Number(r[1]) : ''
  // Fix round 2, finding 1: --test-plan is OPTIONAL (SKILL.md:259, S2 task
  // contract) -- but review-pack.mjs treats ANY non-empty --test-plan value
  // as a real file path and throws a ContentError trying to read it (it only
  // skips the Test-plan-excerpt section when the flag is absent entirely).
  // Passing a placeholder like "(none)" therefore turned EVERY run that
  // legitimately omits a test plan into an unconditional (pack) blocker.
  // Omit the flag entirely when absent -- the same "omit when absent, never
  // emit a placeholder path" treatment radiusFlag already uses above.
  const testPlanFlag = _args.testPlanPath ? ' --test-plan ' + _args.testPlanPath : ''
  return [
    'Run this exact command from the repo root, then report its result:',
    scriptCmd('review-pack.mjs') + ' --plan ' + (_args.buildPlanPath || '(none)') + testPlanFlag +
      ' --files ' + (t.files || []).join(',') + radiusFlag +
      // Fix round 2, finding 2: implementPrompt now tells the implementer to
      // commit (COMMIT_NOTE, below) before this stage runs, so by the time
      // THIS call happens the change may already be committed. `--base
      // worktree` maps to `git diff HEAD`, which goes EMPTY the moment the
      // working tree matches a just-made commit -- so this must diff from
      // the real pre-implement sha (captured in implementStage, before the
      // implementer/commit ran), never from 'HEAD-relative worktree', or the
      // reviewer would see nothing to review. Falls back to _args.baselineSha
      // (run-wide, when the per-task capture is unavailable) then 'worktree'
      // (the pre-existing behavior), same fallback order as before.
      ' --base ' + (t.implBaseSha || _args.baselineSha || 'worktree') + ' --cap ' + CFG.caps.packBytes + ' --out ' + taskDir(t.id) + '/pack.md',
    !radiusFlag ? '(No --radius flag: this task declared no [before, after] context-line pair, so review-pack.mjs\'s own Call-Sites-derived radius stands on its own.)' : '',
    !testPlanFlag ? '(No --test-plan flag: this run has no test plan path in scope -- --test-plan is optional, so the Test-plan excerpt section is simply omitted.)' : '',
    'Report the process exit code as exitCode, and out/bytes/truncated/sections from its LAST stdout JSON line. exitCode must be 0 and out must be the pack.md path actually written, or this call failed.',
  ].filter(Boolean).join('\n')
}
async function packStage(t) {
  if (t.blocked) return t
  // Fix 1: scriptsDir missing means scriptCmd() could not even build a
  // command -- never dispatch an agent to run an unbuildable command (which
  // would just resolve to the old broken relative form); block immediately,
  // same shape as a real review-pack.mjs failure below.
  if (!scriptsDir) {
    return {
      ...t,
      blocked: true,
      blockerFindings: [
        {
          file: '(pack)',
          severity: 'blocker',
          phase: 'Gate & Review',
          summary: 'Task ' + t.id + ' cannot run review-pack.mjs -- no scriptsDir was supplied to this run.',
          detail: 'args.scriptsDir (the absolute path to dev-pipeline\'s scripts directory) is required so this invocation does not depend on the invoking agent\'s cwd, which is always the target workdir -- never dev-pipeline\'s own directory -- in a real run.',
        },
      ],
    }
  }
  const pack = await askAgent(packPrompt(t), { label: 'pack:' + t.id, phase: 'Gate & Review', model: M.haiku, effort: CFG.effort.pack, schema: PACK_SCRIPT_SCHEMA })
  // Fix round 1, finding 1: a non-zero exit or a missing pack.md is a task
  // blocker -- never a silent fallback to a default path. The reviewer must
  // never be handed a file that was not actually built.
  if (!pack || pack.exitCode !== 0 || !pack.out) {
    return {
      ...t,
      blocked: true,
      blockerFindings: [
        {
          file: '(pack)',
          severity: 'blocker',
          phase: 'Gate & Review',
          summary: 'Task ' + t.id + '\'s review-pack.mjs run did not produce a pack.md -- the reviewer must never be handed a file that was never actually built.',
          detail: pack ? ('exitCode=' + pack.exitCode + ' out=' + JSON.stringify(pack.out || '')) : 'the pack-building agent returned nothing',
        },
      ],
    }
  }
  return { ...t, packPath: pack.out }
}

function reviewPrompt(t) {
  return [
    'You are the ADVERSARIAL REVIEWER for task ' + t.id + '. Read the pack at "' + t.packPath + '" -- it has the spec excerpt, the diff, call sites, and the test-plan excerpt.',
    'Judge: spec compliance against this task\'s requirements, code quality, test quality (tests assert real behavior, not mocks), and correctness. You may run ONE focused test when reading raises a specific doubt.',
    'Report specCompliance, findings[] (severity critical|important|minor, file, line, summary, scenario -- the concrete input/state that produces the wrong behavior), and assessment (approved only if there is no critical or important finding).',
  ].join('\n')
}
async function reviewStage(t) {
  if (t.blocked) return t
  const high = isHighRisk(t)
  const model = profile.reviewerAlwaysSonnet ? M.sonnet : (high ? M.opus : M.sonnet) // review on HIGH: Opus (ruling 2026-09-13)
  const review = await askAgent(fableSafe(model, reviewPrompt(t)), { label: 'review:' + t.id, phase: 'Gate & Review', model, effort: CFG.effort.review, schema: REVIEW_SCHEMA })
  // Fix round 1, finding 4: a dead/null reviewer must never read as a clean
  // pass (matching the red-gate and dead-manifest fail-safe pattern already
  // used above) -- it is a task blocker instead of an empty findings list.
  if (!review) {
    return {
      ...t,
      blocked: true,
      blockerFindings: [
        {
          file: '(review)',
          severity: 'blocker',
          phase: 'Gate & Review',
          summary: 'Task ' + t.id + '\'s reviewer agent died or was skipped -- a dead reviewer is not a pass.',
          detail: 'reviewStage received no response; without an adversarial review this task cannot be confirmed correct, so it is blocked rather than defaulting to an empty (clean-looking) findings list.',
        },
      ],
    }
  }
  return { ...t, review }
}

// ---------- A10b: ui-verify task type ----------
// Adapted from pipeline.js.bak-2026-09-12 @1819 (uiDrivePrompt) and @1852
// (uiJudgePrompt). In the old engine the driver and judge were separate
// engine-wide phases with their own agents; here `ui-verify` is a TASK TYPE,
// so the driver is the task's own dedicated stage and the judge IS the
// task's reviewStage (folded in below) -- one review call per plan.
function uiCfgFrom(t) {
  return {
    url: t.url || '',
    startCommand: t.startCommand || '',
    flows: Array.isArray(t.flows) && t.flows.length ? t.flows : ['exercise the surface this change touches, end to end'],
    viewports: Array.isArray(t.viewports) && t.viewports.length ? t.viewports : ['desktop'],
    checks: Array.isArray(t.checks) && t.checks.length ? t.checks : ['console-errors', 'network-failures', 'a11y'],
  }
}
function uiDrivePrompt(t, cfg, priorFindings) {
  const isRerun = Array.isArray(priorFindings)
  return [
    'You are the UI evidence collector for task ' + t.id + '. Exercise the REAL running UI and record what happened as FACTS -- screenshots, assertions, console, network, accessibility measurements. You do NOT decide what is a defect: a separate judge reads your evidence.',
    'You OWN the app process for this task: start it, drive every flow, and STOP it yourself before you report -- even if a flow fails, blows up, or you run out of ideas. Leave no server, browser, or held port behind; report that in processesStopped.',
    'Target URL: ' + (cfg.url || '(not given -- derive it from the dev-server config in this repo)'),
    cfg.startCommand ? 'Start the app with: ' + cfg.startCommand + '. You own that process end to end.' : 'Assume the app is already reachable at the target URL; if not, start it the way this repo documents, and still stop whatever you started before you report.',
    isRerun ? 'THIS IS A RE-VERIFICATION: a fix round has since touched files this task watches. Re-drive every flow from scratch at every viewport with FRESH screenshots. Earlier findings: ' + JSON.stringify(priorFindings) : '',
    'Flows to drive, each end to end:',
    ...cfg.flows.map((f, i) => (i + 1) + '. ' + f),
    'Viewports: run every flow at each of: ' + cfg.viewports.join(', ') + '. Resize before the flow, not during it.',
    'Capture per flow per viewport: every console error/unhandled rejection verbatim; every request that 4xx/5xx, aborts or times out (method, URL, status); accessibility facts (focus order, missing accessible names, contrast/target-size); and the assertions you ran and whether each passed. Take a screenshot at the end of every flow at every viewport and record its path.',
    'A flow you could not drive is status "blocked" with the reason in notes -- and completed=false overall when any flow is blocked, failed, or was not driven at a listed viewport. Do not fix anything and do not commit.',
    'Also write your complete evidence object, matching the schema exactly, to "' + taskDir(t.id) + '/ui-evidence.json".',
  ].filter(Boolean).join('\n')
}
async function uiDriveStage(t) {
  if (t.blocked) return t
  const cfg = uiCfgFrom(t)
  const evidence = await askAgent(uiDrivePrompt(t, cfg, null), { label: 'ui-drive:' + t.id, phase: 'UI verify', model: M.sonnet, effort: CFG.effort.uiDrive, schema: UI_EVIDENCE_SCHEMA })
  if (!evidence) {
    return {
      ...t,
      uiCfg: cfg,
      evidence: null,
      blocked: true,
      blockerFindings: [
        {
          file: '(ui-verify)',
          severity: 'blocker',
          phase: 'UI verify',
          summary: 'Task ' + t.id + '\'s UI driver died or was skipped -- no browser evidence exists for these flows.',
          detail: 'do not treat the change as clean; re-run this task or drive the flows manually',
        },
      ],
    }
  }
  return { ...t, uiCfg: cfg, evidence, evidencePath: taskDir(t.id) + '/ui-evidence.json' }
}
// Adapted from pipeline.js.bak-2026-09-12 @1852 (uiJudgePrompt), folded into
// this task type's OWN reviewStage (one review call, not a separate judge
// agent) -- the plan: "the judge IS the task's reviewer (one agent)".
function uiJudgePrompt(t, cfg, evidence, priorFindings) {
  const isRerun = Array.isArray(priorFindings)
  return [
    'You are the UI verification judge for task ' + t.id + '. A driver agent has just exercised the real running UI and recorded the evidence below. Decide what in it is a defect. Do NOT start the app or drive a browser yourself; if the evidence is insufficient to judge a flow, that is itself a finding.',
    'Flows that were supposed to be driven: ' + cfg.flows.join(' | ') + ' at viewports ' + cfg.viewports.join(', ') + '; checks requested: ' + cfg.checks.join(', ') + '.',
    'Evidence: ' + JSON.stringify(evidence),
    isRerun ? 'THIS IS A RE-VERIFICATION after a fix round. For each earlier finding, rule from the FRESH evidence whether it is gone in the rendered UI or still there; report it again if still there. Earlier findings: ' + JSON.stringify(priorFindings) : '',
    'Rules: a console error or unhandled rejection is a finding, quoted verbatim; a failed or aborted request is a finding with method, URL and status; accessibility gaps against the requested checks are findings; a flow with status "failed" or "blocked", or one not driven at a listed viewport, is a BLOCKER (severity critical) -- the change is unexercised there, not merely a finding; evidence.completed=false or processesStopped=false is a finding in its own right.',
    'Report specCompliance, findings[] (severity critical|important|minor, file, line, summary, scenario), and assessment (approved only if there is no critical or important finding).',
  ].filter(Boolean).join('\n')
}
async function uiReviewStage(t) {
  if (t.blocked) return t
  const high = isHighRisk(t)
  const model = profile.reviewerAlwaysSonnet ? M.sonnet : (high ? M.opus : M.sonnet) // UI judge on HIGH: Opus (ruling 2026-09-13)
  const review = await askAgent(fableSafe(model, uiJudgePrompt(t, t.uiCfg, t.evidence, null)), { label: 'review:' + t.id, phase: 'UI verify', model, effort: CFG.effort.review, schema: REVIEW_SCHEMA })
  if (!review) {
    return {
      ...t,
      blocked: true,
      blockerFindings: [
        {
          file: '(ui-verify)',
          severity: 'blocker',
          phase: 'UI verify',
          summary: 'Task ' + t.id + '\'s UI judge died or was skipped -- evidence exists but nobody ruled on it.',
          detail: 'a browser pass with no verdict is unverified, never clean',
        },
      ],
    }
  }
  // A blocked flow is a blocker in its own right (not merely a finding the
  // judge chooses to raise) -- corroborated mechanically, the same
  // fail-safe philosophy as isStructurallyRed()/gateProblem() above: a judge
  // that stays silent on a blocked flow does not make the flow un-blocked.
  const blockedFlows = (t.evidence && Array.isArray(t.evidence.flows) ? t.evidence.flows : []).filter((f) => f && f.status === 'blocked')
  const findings = Array.isArray(review.findings) ? review.findings.slice() : []
  for (const bf of blockedFlows) {
    const already = findings.some((f) => f.file === '(ui-verify)' && f.scenario === (bf.notes || ''))
    if (already) continue
    findings.push({
      severity: 'critical',
      file: '(ui-verify)',
      line: 0,
      summary: 'Flow "' + bf.flow + '" at viewport "' + bf.viewport + '" could not be driven -- blocked.',
      scenario: bf.notes || '(no reason given)',
    })
  }
  const assessment = blockedFlows.length ? 'needs-fixes' : review.assessment
  return { ...t, review: { ...review, findings, assessment } }
}

// A10/A10b: every non-fixLoop-bearing task type (root-cause, repro-test) --
// and any type whose fixLoopStage never ran because it blocked earlier --
// still needs a terminal status so progressLineFor()/the run-level
// anyTaskNotClean check has something to read. fixLoopStage already sets
// status on every path it reaches; this is a no-op there.
function finishStage(t) {
  if (t.blocked) return t
  if (t.status) return t
  return { ...t, status: 'complete', rounds: t.rounds || 0, clean: t.clean !== false }
}

// ---------- A9: fix loop, round-routing table ----------
// r1-2: plain executor, same tier as the task's own risk. r3: Fable designs
// (a decide-only call) then a separate Fable call executes the design. r4:
// designer AND executor collapse into ONE Fable call (executorIsDesigner) --
// the last-resort round skips the extra round-trip.
function fixRoundPlan(round, t) {
  const hi = isHighRisk(t)
  // Ruling 2026-09-13: the fix EXECUTOR (writes code) is always Sonnet; the fix DESIGNER
  // (decides what to write, rounds >= 3) is Opus. The round-4 "executorIsDesigner" collapse
  // is retired — one model must never both decide and implement.
  if (round <= 2) return { model: M.sonnet, effort: CFG.effort.fixExec, designer: false }
  return { model: M.opus, effort: CFG.effort.fixDesign, designer: true }
}
function fixKey(i) { return '#' + i }
function listFindingsForPrompt(list) {
  return list.map((f, i) => '[' + fixKey(i) + '] [' + (f.severity || '?') + '] ' + f.file + (f.line ? ':' + f.line : '') + ' -- ' + f.summary + (f.scenario ? ' :: ' + f.scenario : ''))
}
function fixExecPrompt(t, round, openFindings, design) {
  const decisions = design && Array.isArray(design.decisions) ? design.decisions : []
  return [
    'You are the FIX EXECUTOR for task ' + t.id + ', round ' + round + ' of ' + CFG.maxFixRounds + '. Only critical/important findings reach this loop -- a minor finding never does.',
    // Fix round 1, finding 9: bring this up to implementPrompt's own
    // standard -- the brief/prior-report path and the owned-files list were
    // missing here.
    'Task brief: "' + (t.briefPath || taskDir(t.id) + '/brief.md') + '". Prior implementer report: "' + taskDir(t.id) + '/report.md".',
    'Files you own for this task:',
    ...(t.files || []).map((f) => '- ' + f),
    'Findings to fix, keyed for reference:',
    ...listFindingsForPrompt(openFindings),
    decisions.length
      ? 'A planner has already decided each finding by the same keys; implement its design exactly. If a design does not fit the code you find, say so in notes rather than improvising:\n' +
        decisions.map((d) => '  ' + (d.key || '?') + ': ' + (d.action || 'fix') + ' -- ' + (d.design || '(no design given)')).join('\n')
      : 'Decide and implement the minimal correct fix for each finding yourself.',
    (verifyCommands.perRound || []).length
      ? 'Also run, scoped to this task\'s files where possible, to confirm your fix does not regress the suite: ' + (verifyCommands.perRound || []).join(' ; ')
      : '',
    COMMIT_NOTE,
    'Report status, filesChanged, deviations, and notes.',
  ].filter(Boolean).join('\n')
}
function fixDesignPrompt(t, round, openFindings, briefRes) {
  return [
    'You are the FIX PLANNER for task ' + t.id + ', round ' + round + '. You decide; you do not read the repository or run commands -- everything you may rule on is below' +
      (briefRes && briefRes.out ? ' plus the code brief at "' + briefRes.out + '"' : ' (the brief agent produced nothing -- decide from the findings alone, conservatively)') + '.',
    'Where the evidence is insufficient, choose "fix" with a conservative design: a dropped real defect ships.',
    'Findings, keyed for reference:',
    ...listFindingsForPrompt(openFindings),
    'For each finding give key, action (fix|dispute|defer -- dispute only when you can prove the finding is not real; defer only for a decision this run cannot make), a 2-6 sentence design, the invariant it must preserve, the test to add or strengthen, and reason.',
  ].join('\n')
}
function fixDesignAndExecPrompt(t, round, openFindings, briefRes) {
  return [
    fixDesignPrompt(t, round, openFindings, briefRes),
    'This is the LAST fix round (round ' + CFG.maxFixRounds + '): after deciding, make the change yourself in this same turn instead of handing the design to a separate executor.',
    (verifyCommands.perRound || []).length
      ? 'Also run, scoped to this task\'s files where possible, to confirm your fix does not regress the suite: ' + (verifyCommands.perRound || []).join(' ; ')
      : '',
    COMMIT_NOTE,
    'Report status, filesChanged, deviations, and notes (same shape as an implementer report).',
  ].filter(Boolean).join('\n')
}
function fixBriefScriptPrompt(t, openFindings, round) {
  // Fix round 1, finding 3: the engine has no filesystem access, so nothing
  // wrote the findings JSON fix-brief.mjs's readFileSync expects -- inline
  // the exact JSON and explicitly instruct the agent to write it FIRST.
  const findingsPath = taskDir(t.id) + '/fix-r' + round + '-findings.json'
  return [
    'First, write this EXACT JSON to "' + findingsPath + '" (create the directory first if needed):',
    JSON.stringify(openFindings),
    'Then run this exact command from the repo root, and report its result:',
    scriptCmd('fix-brief.mjs') + ' --findings ' + findingsPath + ' --cap ' + CFG.caps.fableBriefBytes + ' --out ' + taskDir(t.id) + '/fix-r' + round + '.md',
    'The script prints its result as the LAST stdout line: one JSON object {out, bytes, truncated, sections, exitCode}. Report exactly that object. Report the process exit code as exitCode: it must be 0 and out must be the fix-brief path actually written, or this call failed.',
  ].join('\n')
}
async function fixRound(t, round, openFindings) {
  const plan = fixRoundPlan(round, t)
  const label = 'fix:' + t.id + ':r' + round
  if (!plan.designer) {
    const { response: exec, violation } = await withWorkdirGuard(t, label, () =>
      askAgent(fableSafe(plan.model, fixExecPrompt(t, round, openFindings, null)), { label, phase: 'Fix', model: plan.model, effort: plan.effort, schema: IMPL_SCHEMA }),
    )
    return { plan, design: null, exec, guardViolation: violation }
  }
  // Fix round 1, finding 6: a Fable-session caller can rule the fix design
  // inline and pass it as args.fixPlanOverride to skip the brief + design
  // calls entirely (light-loop.js:550-551 pattern) -- checked before either
  // is dispatched.
  if (_args.fixPlanOverride) {
    const design = _args.fixPlanOverride
    const { response: exec, violation } = await withWorkdirGuard(t, label, () =>
      askAgent(withToolCap(fixExecPrompt(t, round, openFindings, design)), { label, phase: 'Fix', model: plan.model, effort: plan.effort, schema: IMPL_SCHEMA }),
    )
    return { plan, design, exec, designOverridden: true, guardViolation: violation }
  }
  // Fix 1/Fix 2 (real smoke-run finding): fix-brief.mjs shares
  // task-brief.mjs's exact schema and cwd-dependent invocation risk. A
  // missing scriptsDir (command unbuildable) or a nonzero exit must never be
  // trusted as if it produced a real brief -- but unlike packStage's hard
  // gate, this brief is supplementary context the design step already has an
  // explicit "produced nothing" fallback for (fixDesignPrompt, above), so a
  // failure here degrades to that SAME conservative fallback rather than
  // blocking the whole task. The failure is still never silent: it is
  // surfaced as a (brief) gap finding, folded into the run's findings by
  // fixLoopStage below -- the identical non-fatal-but-visible pattern
  // rereviewStage already uses for a failed re-review pack a few lines down.
  const briefRaw = scriptsDir
    ? await askAgent(fixBriefScriptPrompt(t, openFindings, round), { label: 'fix-brief:' + t.id + ':r' + round, phase: 'Fix', model: M.haiku, effort: CFG.effort.baseline, schema: SCRIPT_RESULT_SCHEMA })
    : null
  const briefOk = !!(briefRaw && briefRaw.exitCode === 0 && briefRaw.out)
  const brief = briefOk ? briefRaw : null
  const briefGap = briefOk ? null : {
    file: '(brief)',
    severity: 'major',
    phase: 'Fix',
    summary: 'Fix-brief for task ' + t.id + ' round ' + round + ' could not run or failed to build -- the design step proceeded from the findings alone.',
    detail: !scriptsDir
      ? 'no scriptsDir (args.scriptsDir) is available in this run, so fix-brief.mjs\'s command could not be built.'
      : briefRaw ? ('exitCode=' + briefRaw.exitCode + ' out=' + JSON.stringify(briefRaw.out || '')) : 'the fix-brief agent returned nothing',
  }
  if (plan.executorIsDesigner) {
    // UNREACHABLE since 2026-09-13 — executorIsDesigner is never set (see fixRouting). Kept for
    // resume-compat with older runs; if ever reached it runs on Opus, never Fable.
    const { response: exec, violation } = await withWorkdirGuard(t, label, () =>
      askAgent(withToolCap(fixDesignAndExecPrompt(t, round, openFindings, brief)), { label, phase: 'Fix', model: M.opus, effort: plan.effort, schema: IMPL_SCHEMA }),
    )
    return { plan, design: null, exec, briefGap, guardViolation: violation }
  }
  const design = await askAgent(fixDesignPrompt(t, round, openFindings, brief), { label: 'fix-plan:' + t.id + ':r' + round, phase: 'Fix', model: M.opus, effort: CFG.effort.fixDesign, schema: FIX_DESIGN_SCHEMA })
  // executor is Sonnet regardless of plan.model (which names the DESIGNER at rounds >= 3) — ruling 2026-09-13
  const { response: exec, violation } = await withWorkdirGuard(t, label, () =>
    askAgent(withToolCap(fixExecPrompt(t, round, openFindings, design)), { label, phase: 'Fix', model: M.sonnet, effort: CFG.effort.fixExec, schema: IMPL_SCHEMA }),
  )
  return { plan, design, exec, briefGap, guardViolation: violation }
}

// Fix round 1, finding 2: a small Haiku `git rev-parse HEAD` call, used both
// to capture a round's real fixBaseSha before it starts and to capture the
// new HEAD after the executor's (committed) work lands.
async function captureGitSha(label, phaseName) {
  const res = await askAgent('Run `git rev-parse HEAD` from the repo root and report its single output line as sha.', { label, phase: phaseName, model: M.haiku, effort: CFG.effort.baseline, schema: GIT_SHA_SCHEMA })
  return res && res.sha ? res.sha : null
}
function rereviewPackPrompt(t, round, fixBaseSha) {
  return [
    'Run this exact command from the repo root, then report its result:',
    scriptCmd('review-pack.mjs') + ' --plan ' + _args.buildPlanPath + ' --base ' + fixBaseSha + ' --files ' + (t.files || []).join(',') + ' --cap ' + CFG.caps.packBytes + ' --out ' + taskDir(t.id) + '/pack-r' + round + '.md',
    'This pack scopes to ONLY the fix diff from round ' + round + ' -- everything changed since commit ' + fixBaseSha + ' -- not the whole task change.',
    'Report the process exit code as exitCode, and out/bytes/truncated/sections from its LAST stdout JSON line.',
  ].join('\n')
}
function rereviewPrompt(t, round, openFindings, packPath) {
  return [
    'You are the RE-REVIEWER for task ' + t.id + ' after fix round ' + round + '. Read the pack at "' + packPath + '" -- it is scoped to ONLY this round\'s fix diff.',
    'For each prior finding below, report ADDRESSED or NOT ADDRESSED with file:line evidence -- never take the fixer\'s word for it:',
    ...listFindingsForPrompt(openFindings),
    'Report newFindings ONLY for defects introduced inside the fix diff itself -- never re-litigate something the original review already passed.',
  ].join('\n')
}
// Fix round 1, finding 2: the old version passed a literal placeholder
// string as --base and omitted the required --plan (review-pack.mjs's
// parseArgs exits 2 on a missing --plan), and never captured or used the
// pack path it built. Now: real --plan, a real captured fixBaseSha, and the
// returned pack path is what the re-reviewer actually reads. If no plan
// path is in scope, or no base sha could be captured, that is a
// controller-visible gap -- surfaced as a (pack) finding, never spent on a
// call that would just fail.
async function rereviewStage(t, round, openFindings, fixBaseSha) {
  // Fix 1: a missing scriptsDir joins the existing "cannot run" gap checks
  // below -- scriptCmd() could not build a command, so never dispatch an
  // agent to run one.
  if (!_args.buildPlanPath || !fixBaseSha || !scriptsDir) {
    return {
      perFinding: openFindings.map((f, i) => ({ key: fixKey(i), status: 'NOT ADDRESSED', evidence: 'no build plan path, base sha, or scriptsDir in scope -- review-pack.mjs cannot run without --plan, a real --base, and a resolvable script path' })),
      newFindings: [],
      gapFinding: {
        file: '(pack)',
        severity: 'major',
        phase: 'Fix',
        summary: 'Re-review pack for task ' + t.id + ' round ' + round + ' could not run: ' + (!_args.buildPlanPath ? 'no build plan path (_args.buildPlanPath) is available in this run' : !fixBaseSha ? 'no base sha was captured for this round' : 'no scriptsDir (args.scriptsDir) is available in this run') + '.',
        detail: 'review-pack.mjs requires --plan, a real --base ref, and a resolvable scripts directory; without them the call would fail, so it was not attempted. Every finding in this round defaults to NOT ADDRESSED (fail-safe).',
      },
    }
  }
  const packRes = await askAgent(rereviewPackPrompt(t, round, fixBaseSha), { label: 'pack:' + t.id + ':r' + round, phase: 'Fix', model: M.haiku, effort: CFG.effort.pack, schema: PACK_SCRIPT_SCHEMA })
  if (!packRes || packRes.exitCode !== 0 || !packRes.out) {
    return {
      perFinding: openFindings.map((f, i) => ({ key: fixKey(i), status: 'NOT ADDRESSED', evidence: 're-review pack failed to build (exitCode=' + (packRes && packRes.exitCode) + ')' })),
      newFindings: [],
      gapFinding: {
        file: '(pack)',
        severity: 'major',
        phase: 'Fix',
        summary: 'Re-review pack for task ' + t.id + ' round ' + round + ' failed to build.',
        detail: packRes ? JSON.stringify(packRes) : 'the pack-building agent returned nothing',
      },
    }
  }
  const high = isHighRisk(t)
  const model = high ? M.opus : M.sonnet // re-review on HIGH: Opus (ruling 2026-09-13)
  const rr = await askAgent(fableSafe(model, rereviewPrompt(t, round, openFindings, packRes.out)), { label: 're-review:' + t.id + ':r' + round, phase: 'Fix', model, effort: CFG.effort.review, schema: REREVIEW_SCHEMA })
  // A dead/skipped re-reviewer must never read as silent success (same
  // fail-safe philosophy as gateProblem()/the dead-manifest handling above):
  // every prior finding defaults to NOT ADDRESSED.
  return rr || { perFinding: openFindings.map((f, i) => ({ key: fixKey(i), status: 'NOT ADDRESSED', evidence: 're-reviewer returned nothing' })), newFindings: [] }
}
function makeRuling(taskId, decision, why, costIfWrong) {
  return { taskId, decision, why, costIfWrong, line: 'Ruling: ' + decision + ' -- ' + why + ' -- ' + costIfWrong }
}
async function fixLoopStage(t) {
  if (t.blocked) return t
  const review = t.review || { specCompliance: 'partial', findings: [], assessment: 'needs-fixes' }
  const allFindings = Array.isArray(review.findings) ? review.findings : []
  const minorFindings = allFindings.filter((f) => f.severity === 'minor')
  let openFindings = allFindings.filter((f) => f.severity === 'critical' || f.severity === 'important')
  // Fix round 1, finding 2: (pack) gaps surfaced by a round's re-review
  // (no plan path, no base sha, or a failed pack build) -- merged into the
  // run's findings at the end, never silently dropped.
  const packGaps = []
  // Fix round 1, finding 11: retain every round's {plan, design, exec}
  // evidence (plus the captured commit shas) on the task, for A14's
  // fixRouting/redGate aggregation and so a Ruling can cite something real.
  const roundHistory = []
  // Fix (confirmedFindings undercount): a round's re-review (rr.newFindings,
  // below) can discover defects introduced by THAT round's own fix diff --
  // distinct from the prior findings it is checking ADDRESSED/NOT ADDRESSED.
  // Those used to flow into openFindings/minorFindings for the NEXT round
  // only, never written back onto anything A14's confirmedFindings assembly
  // (~line 2699) reads (tr.review.findings alone) -- so a task whose round 1
  // fix triggered 2 brand-new criticals, both then fixed and confirmed clean
  // in round 2, ended with confirmedFindings holding only the ORIGINAL
  // finding: an unbounded undercount on a genuinely successful run. Every
  // round's newly-discovered critical/important findings (the severities
  // that actually enter this loop -- never the filtered-out minors) are
  // accumulated here and folded into the review this function returns, so
  // confirmedFindings reads the UNION of every finding ever confirmed for
  // this task across every round.
  const discoveredFindings = []

  // Only critical/important enter the loop; minor -> progress line, never a
  // fix round (brief I).
  if (!openFindings.length) return { ...t, status: 'complete', rounds: 0, clean: true, minorFindings, rulings: [], roundHistory, packGaps }

  for (let round = 1; round <= CFG.maxFixRounds; round++) {
    const roundOpen = openFindings
    const fixBaseSha = await captureGitSha('fix-base:' + t.id + ':r' + round, 'Fix')
    const roundResult = await fixRound(t, round, roundOpen)
    // E7: a confirmed main-checkout drift stops the loop immediately -- the
    // tree this round's fix landed in is suspect, so no further round or
    // re-review should run against it.
    if (roundResult.guardViolation) {
      return {
        ...t,
        blocked: true,
        status: 'open',
        clean: false,
        minorFindings,
        roundHistory,
        packGaps,
        blockerFindings: [roundResult.guardViolation],
      }
    }
    // Fix 2: a failed fix-brief (roundResult.briefGap) folds into the same
    // packGaps channel a failed re-review pack already uses -- never silent,
    // surfaced into this task's findings via the merge at A14 below.
    if (roundResult.briefGap) packGaps.push(roundResult.briefGap)
    const headAfter = await captureGitSha('fix-head:' + t.id + ':r' + round, 'Fix')
    const rr = await rereviewStage(t, round, roundOpen, fixBaseSha)
    if (rr.gapFinding) packGaps.push(rr.gapFinding)
    roundHistory.push({ round, plan: roundResult.plan, design: roundResult.design, exec: roundResult.exec, fixBaseSha, headAfter })
    const perFinding = Array.isArray(rr.perFinding) ? rr.perFinding : []
    const addressed = new Set(perFinding.filter((p) => p && p.status === 'ADDRESSED').map((p) => p.key))
    const stillOpen = roundOpen.filter((f, i) => !addressed.has(fixKey(i)))
    const newFindings = Array.isArray(rr.newFindings) ? rr.newFindings : []
    minorFindings.push(...newFindings.filter((f) => f.severity === 'minor'))
    const newOpen = newFindings.filter((f) => f.severity === 'critical' || f.severity === 'important')
    discoveredFindings.push(...newOpen)
    openFindings = [...stillOpen, ...newOpen]
    if (!openFindings.length) {
      return {
        ...t,
        status: 'complete',
        rounds: round,
        clean: true,
        minorFindings,
        rulings: [],
        roundHistory,
        packGaps,
        review: { ...review, findings: [...allFindings, ...discoveredFindings] },
      }
    }
  }
  // Cap reached (brief F): a Ruling, never a silent discard -- surfaced on
  // the task AND merged into the run's own rulings[] below. Fix round 1,
  // finding 11: cite the last round's actual executor report, not a bare
  // count with nothing real behind it.
  const lastRound = roundHistory[roundHistory.length - 1]
  const lastExecNote = lastRound && lastRound.exec
    ? 'last executor report: status=' + lastRound.exec.status + (lastRound.exec.notes ? ', notes=' + lastRound.exec.notes : '')
    : 'no executor report on the final round'
  const ruling = makeRuling(
    t.id,
    'open',
    openFindings.length + ' finding(s) still open after ' + CFG.maxFixRounds + ' fix round(s); ' + lastExecNote,
    'the confirmed defect(s) above ship unfixed',
  )
  return {
    ...t,
    status: 'open',
    rounds: CFG.maxFixRounds,
    clean: false,
    minorFindings,
    remaining: openFindings,
    rulings: [ruling],
    roundHistory,
    packGaps,
    review: { ...review, findings: [...allFindings, ...discoveredFindings] },
  }
}

// A10/A10b: per-type stage chain. `revert-probe` is deliberately absent --
// it never runs through runTask/pipeline() at all (it must execute strictly
// sequentially across probes, never via wave-level parallel()); see the
// dedicated sequential loop in the Implement phase below.
// T2 cost-plan: briefStage/testAuthorStage/redCheckStage/packStage/
// reviewStage/fixLoopStage/uiDriveStage/uiReviewStage each tag their own
// askAgent calls with one of these five phase names already (for
// phaseAgentCounts/findings attribution) -- meterStage makes phaseReport's
// tokens/estUsd agree with that same attribution instead of reporting
// estUsd:null for all five. implementStage/rootCauseStage/docsImplementStage
// tag themselves 'Implement' and fixGateStage runs no agent at all, so none
// of those need wrapping -- they are already inside the run-level Implement
// bracket (startPhase('Implement')/endPhase('Implement') around the whole
// wave loop, above) with no separate title to disambiguate.
const briefMeter = meterStage('Author tests', briefStage)
function chainForType(type) {
  if (type === 'root-cause') return [briefMeter, rootCauseStage, finishStage]
  if (type === 'repro-test') return [briefMeter, meterStage('Author tests', testAuthorStage), meterStage('Red gate', redCheckStage), finishStage]
  if (type === 'fix') return [briefMeter, fixGateStage, implementStage, meterStage('Gate & Review', packStage), meterStage('Gate & Review', reviewStage), meterStage('Fix', fixLoopStage), finishStage]
  if (type === 'docs') return [briefMeter, docsImplementStage, meterStage('Gate & Review', packStage), meterStage('Gate & Review', reviewStage), meterStage('Fix', fixLoopStage), finishStage]
  if (type === 'ui-verify') return [briefMeter, meterStage('UI verify', uiDriveStage), meterStage('UI verify', uiReviewStage), meterStage('Fix', fixLoopStage), finishStage]
  return [briefMeter, meterStage('Author tests', testAuthorStage), meterStage('Red gate', redCheckStage), implementStage, meterStage('Gate & Review', packStage), meterStage('Gate & Review', reviewStage), meterStage('Fix', fixLoopStage), finishStage]
}
// E8: an agent that ends its turn with no usable result (no StructuredOutput,
// or a thunk that outright rejects) must block only the ONE task it was
// working on, never crash the run. withWorkdirGuard already catches this at
// the agent-call boundary for every file-touching stage (test-author,
// implement, docs-implement, every fix executor); this is the outer safety
// net for anything else that still throws out of a task's stage chain (a
// stage not routed through withWorkdirGuard, or a genuine programmer error).
// Keeps the original task's id/type/dependsOn via the spread, so dependents
// still see this as a real, blocked dependency result (fixGateStage's own
// resultsById lookup, for example) rather than a missing one.
function blockedTaskFromEngineFailure(t, phaseName, err) {
  return {
    ...t,
    blocked: true,
    status: 'open',
    clean: false,
    blockerFindings: [
      {
        file: '(engine)',
        severity: 'blocker',
        phase: phaseName,
        summary: 'Task ' + t.id + ': an agent in ' + phaseName + ' ended without a usable result (no StructuredOutput / thunk rejected) -- task blocked, run continues.',
        detail: err ? (err.message || String(err)) : '(no error captured)',
      },
    ],
  }
}
async function runTask(t) {
  let out
  try {
    ;[out] = await pipeline([t], ...chainForType(t.type))
  } catch (e) {
    out = blockedTaskFromEngineFailure(t, 'Implement', e)
  }
  if (!out) out = blockedTaskFromEngineFailure(t, 'Implement', null)
  fireCheckpoint('checkpoint:' + t.id, { task: out, progressLine: progressLineFor(out) })
  return out
}

// ---------- A13: fire-and-forget checkpoints ----------
// Escapes every non-ASCII character (code point >= 0x80) to \uXXXX so a JSON
// payload -- which may legitimately carry an agent's own non-ASCII findings
// text -- stays ASCII-safe to hand to a WRITER agent. (The regex's safe range
// \x00-\x7f is "ASCII", not "printable ASCII": control bytes like DEL/0x7F
// pass through unescaped too, which is fine -- this is about the DATA a
// payload carries, never about pipeline.js's own SOURCE: the ASCII-only scan
// in dry-run.mjs enforces that separately, on this file's bytes.)
function asciiSafeJson(payload) {
  return JSON.stringify(payload).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}
const CHECKPOINT_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean', description: 'true ONLY if the JSON.parse self-check on the freshly written card exited 0' },
    path: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['written', 'note'],
}
// Every checkpoint alias in this file is 'checkpoint:<id>' (runTask),
// 'checkpoint:<id>:ui-reverify' (A10b) or 'checkpoint:sibling-sweep:<i>'
// (A11) -- none of those are one of the ten canonical ledger phase names, so
// this derives a reasonable one from the alias's own shape for the writer's
// own PHASE/LABEL tag (session-usage.mjs attribution), rather than passing
// the alias itself as `phase`.
function checkpointPhase(alias) {
  if (/:ui-reverify$/.test(alias)) return 'UI verify'
  if (/^checkpoint:sibling-sweep:/.test(alias)) return 'Verify'
  return 'Gate & Review'
}
let ckSeq = 0
const checkpoints = []
// The real checkpoint writer (adapted from scripts/light-loop.js @350-370): a
// Haiku agent writes ONE durable JSON card per checkpoint, appends the
// payload's own progressLine (if any) to the run's progress ledger, then
// self-checks its own output with `node -e "JSON.parse(...)"` before it may
// report written:true -- a malformed card (the real incident this fixes,
// 04-implement.json) is never silently accepted as a success. Never throws:
// a dead/declined agent, or an askAgent() exception, both resolve to a
// written:false record instead.
async function checkpoint(alias, payload) {
  ckSeq += 1
  const seq = String(ckSeq).padStart(2, '0')
  const safeName = alias.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const cardPath = runDir + '/phases/' + seq + '-' + safeName + '.json'
  const body = asciiSafeJson(payload)
  const progressLine = payload && typeof payload.progressLine === 'string' ? payload.progressLine : ''
  const prompt = [
    'You are the CHECKPOINT WRITER -- mechanical. The only files you may touch are the one card path below and, if a progress line is given, the run progress ledger.',
    '1. Run `mkdir -p "' + runDir + '/phases"`.',
    '2. Write EXACTLY this JSON, verbatim, to "' + cardPath + '" (create or overwrite):',
    body,
    progressLine
      ? '3. APPEND this exact line, followed by a newline, to "' + runDir + '/progress.md" (create the file first if it does not exist): ' + progressLine
      : '3. (no progress line was supplied for this checkpoint -- do not touch progress.md)',
    '4. SELF-CHECK: run `node -e "JSON.parse(require(\'fs\').readFileSync(\'' + cardPath + '\', \'utf8\'))"`. Report written:true ONLY if that command exits 0 (the card parses as valid JSON) -- if it exits nonzero, report written:false and quote the parse error in note.',
    '5. Touch NOTHING else -- no other file, no commit, no git command.',
    'Report written, path (absolute), and note.',
  ].join('\n')
  let res = null
  try {
    res = await askAgent(prompt, { label: alias, phase: checkpointPhase(alias), model: M.haiku, effort: CFG.effort.checkpoint, schema: CHECKPOINT_SCHEMA })
  } catch (e) {
    res = null
  }
  const record = {
    seq: ckSeq,
    alias,
    payload,
    path: cardPath,
    written: !!(res && res.written),
    note: (res && res.note) || (res ? '' : 'checkpoint agent died or returned nothing -- non-fatal, run continues'),
  }
  checkpoints.push(record)
  return record
}
// Fire-and-forget: the caller never awaits this directly. Every pending
// checkpoint promise is collected here and drained with Promise.allSettled
// right before the run's own result assembly, so result.checkpoints[] is
// always complete by the time a caller sees it -- never a race.
const pendingCheckpoints = []
function fireCheckpoint(alias, payload) { pendingCheckpoints.push(checkpoint(alias, payload).catch(() => null)) }

// ---------- A14: result writer ----------
// Adapted from scripts/light-loop.js's own Result phase (@~642-655), plus
// the same JSON.parse self-check A13's checkpoint() introduced (the real
// incident that fix prevents -- a malformed checkpoint card -- applies
// exactly as much to result.json, the one file every downstream tool reads).
const RESULT_WRITE_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean', description: 'true ONLY if the JSON.parse self-check on the freshly written result.json exited 0' },
    path: { type: 'string' },
    endedAt: { type: 'string', description: 'the real UTC ISO timestamp the writer captured -- pipeline.js itself has no Date.now()' },
    note: { type: 'string' },
  },
  required: ['written', 'endedAt', 'note'],
}
async function runResult(payload) {
  const resultPath = runDir + '/result.json'
  const body = asciiSafeJson(payload)
  const prompt = [
    'You are the RESULT WRITER -- mechanical, the last step of this run.',
    '1. Get the current UTC ISO timestamp (e.g. `node -e "console.log(new Date().toISOString())"`, or the OS equivalent) -- that is endedAt.',
    '2. Write EXACTLY this JSON to "' + resultPath + '" (create or overwrite), with your real endedAt merged in as the top-level "endedAt" field -- change nothing else:',
    body,
    '3. SELF-CHECK: run `node -e "JSON.parse(require(\'fs\').readFileSync(\'' + resultPath + '\', \'utf8\'))"`. Report written:true ONLY if that command exits 0 (the file parses as valid JSON) -- if it exits nonzero, report written:false and quote the parse error in note.',
    '4. Touch NOTHING else.',
    'Report written, path, endedAt (the value you actually wrote), and note.',
  ].join('\n')
  let res = null
  try {
    res = await askAgent(prompt, { label: 'result', phase: 'Final pass', model: M.haiku, effort: CFG.effort.baseline, schema: RESULT_WRITE_SCHEMA })
  } catch (e) {
    res = null
  }
  return res
}
function progressLineFor(t) {
  // E8: a null/undefined task (a wave/parallel slot that never got normalised
  // back to a real task object) must render a line, never throw.
  if (!t) return 'Task ?: no result'
  if (t.status === 'complete') return 'Task ' + t.id + ': complete (' + (t.rounds ? t.rounds + ' fix round(s), ' : '') + 'review clean)'
  if (t.status === 'open') {
    // Fix round 1, finding 4: fixGateStage (and rootCauseStage's dead-agent
    // path) both produce status:'open' + blocked:true WITHOUT ever entering
    // the fix-round loop (no t.rounds set) -- the generic "fix round X/Y"
    // wording below implied a fix round was attempted when none was. Only
    // this specific shape (blocked, no rounds recorded) gets the accurate
    // wording; a task that genuinely ran 0 rounds because it was clean on
    // first review has status:'complete' already, never 'open', so it never
    // reaches this branch at all.
    // Fix round 2, finding 3 (dead code): the original condition also
    // checked `t.fixRounds == null` -- `fixRounds` is never set anywhere in
    // this file (the real field is `rounds`, checked just above); that
    // clause was always true and never changed this branch's behavior.
    if (t.blocked && t.rounds == null) {
      return 'Task ' + t.id + ': blocked before fix loop (' + ((t.rulings && t.rulings.length) || 0) + ' ruling(s), not clean)'
    }
    return 'Task ' + t.id + ': fix round ' + (t.rounds || 0) + '/' + CFG.maxFixRounds + ' (' + ((t.rulings && t.rulings.length) || 0) + ' ruling(s), not clean)'
  }
  if (t.blocked) return 'Task ' + t.id + ': blocked (' + ((t.blockerFindings && t.blockerFindings.length) || 0) + ' blocker(s))'
  return 'Task ' + t.id + ': ' + (t.status || 'pending')
}

endPhase('Baseline')
startPhase('Implement')
// A10 (revert-probe): excluded from the wave graph entirely -- it runs in a
// dedicated, strictly-sequential loop after the main wave loop (below),
// never through parallel(). buildWaves/validateTasks both already accept
// dependsOn edges FROM a revert-probe TO the fix it probes; running it
// afterward, once every wave (including the fix's) has already finished,
// satisfies that ordering trivially.
const waveTasks = tasks.filter((t) => t.type !== 'revert-probe')
const { waves, issues: waveIssues } = buildWaves(waveTasks)
for (const issue of waveIssues) findings.push(toBuildPlanBlocker(issue))
const taskResults = []
// A10 (fix): fixGateStage looks up its root-cause dependency's OWN result by
// id -- populated wave by wave, so by the time a `fix` task's wave runs,
// every wave before it (which dependsOn ordering guarantees includes its
// root-cause) has already recorded its result here.
const resultsById = new Map()
const RUN_ARTIFACTS_SCHEMA = {
  type: 'object',
  properties: { ran: { type: 'boolean' }, missing: { type: 'array', items: { type: 'string' } } },
  required: ['ran', 'missing'],
}
// E9, defence in depth (rule 4): task-brief.mjs and review-pack.mjs are
// handed _args.buildPlanPath/_args.testPlanPath as bare paths and trust they
// still exist on disk. The Baseline manifest checked that ONCE, before any
// agent wrote anything -- but the E9 incident is exactly a case of one of
// these files vanishing MID-RUN (a scope-guard remediation deleted the run's
// own build-plan.md/test-plan.md). Without this, every task from that point
// on independently fails to read its brief/pack and blocks with its own
// unrelated-looking finding, burying the one real cause under N cascades.
// Checked once per wave boundary (cheap, Haiku) -- fail-safe: a dead/
// unreadable check agent never aborts the run on the GUARD's own failure,
// only a CONFIRMED missing path does.
async function checkRunArtifactsPresent(label) {
  if (!planPaths.length) return null
  const res = await askAgent(
    'For each path below, check directly whether it exists on disk right now (e.g. `test -f "<path>" && echo EXISTS || echo MISSING`, or the OS equivalent) and report every one that is MISSING in `missing`:\n' +
      planPaths.map((p) => '- ' + p).join('\n') +
      '\nReport ran:true only if every check actually executed.',
    { label, phase: 'Implement', model: M.haiku, effort: CFG.effort.baseline, schema: RUN_ARTIFACTS_SCHEMA },
  )
  if (!res || !res.ran || !Array.isArray(res.missing) || !res.missing.length) return null
  return res.missing
}
function blockedTaskFromMissingRunArtifacts(t, missing) {
  return {
    ...t,
    blocked: true,
    status: 'open',
    clean: false,
    blockerFindings: [
      {
        file: '(run-artifacts)',
        severity: 'blocker',
        phase: 'Implement',
        summary: 'RUN ARTIFACTS MISSING -- the run was stopped before this task ran rather than cascading into a confusing per-task failure.',
        detail: 'This run\'s build/test plan path(s) no longer exist on disk: ' + missing.join(', ') + '. They were present at Baseline; task-brief.mjs and review-pack.mjs cannot run without them, so the run aborted at a wave boundary instead of letting every remaining task fail independently.',
      },
    ],
  }
}
for (const wave of waves) {
  const missingArtifacts = await checkRunArtifactsPresent('run-artifacts-check:' + (wave[0] ? wave[0].id : 'wave'))
  if (missingArtifacts) {
    // Each remaining task gets its own (run-artifacts) blockerFinding below,
    // which the existing per-task merge (`if (Array.isArray(tr.blockerFindings))
    // findings.push(...tr.blockerFindings)`) already carries into
    // result.remainingFindings -- the same path AX/BA's per-task findings
    // use, so no separate top-level push is needed here.
    console.log('[run-artifacts] MISSING: ' + missingArtifacts.join(', ') + ' -- stopping the run instead of cascading every remaining task into blocked')
    for (const t of waveTasks) {
      if (resultsById.has(t.id)) continue
      const blocked = blockedTaskFromMissingRunArtifacts(t, missingArtifacts)
      resultsById.set(t.id, blocked)
      taskResults.push(blocked)
    }
    break
  }
  await warmUpWave(pairsFor(wave), 'Implement')
  const rawWaveResults = await parallel(wave.map((t) => () => runTask(t)))
  // E8 safety net: runTask (above) is now built to never reject or resolve
  // empty, but parallel() is a Workflow-provided primitive this engine does
  // not control -- if a slot still comes back null/undefined (a rejected
  // thunk the harness swallowed, a killed worker, anything), map it back to
  // the task actually scheduled in that slot rather than let a downstream
  // consumer (progressLineFor, resultsById, remainingFindings) dereference a
  // null.
  const waveResults = rawWaveResults.map((r, i) => r || blockedTaskFromEngineFailure(wave[i], 'Implement', new Error('parallel() returned no result for this task slot')))
  for (const r of waveResults) resultsById.set(r.id, r)
  taskResults.push(...waveResults)
}

// ---------- A10 (revert-probe): sequential probes + ONE checksum:after ----------
function revertProbePrompt(t) {
  return [
    'You are the FIX-REVERT PROBE for task ' + t.id + '. The fix in "' + t.file + '" is what makes a named test pass. You will back the file up OUTSIDE the repo, revert it to its COMMITTED (HEAD) content, prove the named test FAILS without the fix, then restore your backup exactly.',
    'Target file: ' + t.file,
    'Test that MUST FAIL without the fix -- run ONLY this, nothing else: ' + t.test,
    '1. CHECK IT IS TRACKED: run `git ls-files -- "' + t.file + '"`. If it prints nothing, or `git show HEAD:' + t.file + '` cannot produce content, report fallback="untracked", caught=false, restored=true, and STOP -- there is no committed version to revert to.',
    '2. BACK UP, OUTSIDE THE REPO: copy the file into the OS temp directory under a unique name (a file copy, never git). Report that absolute path as backupPath.',
    '3. REVERT: `git show HEAD:' + t.file + ' > "' + t.file + '"` (Git Bash, so the bytes land unchanged). NEVER use `git checkout`, `git restore`, `git stash` or `git reset` -- uncommitted work from this run lives elsewhere in this tree and those commands would destroy it.',
    '4. RUN ONLY: ' + t.test + '. Reverting the fix re-introduces the bug, so the test MUST FAIL on an assertion -- caught=true ONLY then. A pass, a skip, or a collection/compile error means caught=false.',
    '5. RESTORE: copy the backup back over "' + t.file + '". Again: never git checkout/restore/stash/reset.',
    'Report caught, restored, evidence (the assertion failure message, or the output proving the test is blind to the fix), backupPath, and fallback (empty string unless step 1 applied). An independent checksum agent checks your restore afterward against the digest recorded before this run touched the file -- never claim restored:true without having actually compared the file to your backup.',
  ].join('\n')
}
async function runRevertProbeTask(t) {
  // E8: fold a thrown/rejected probe-agent call into the SAME null-response
  // shape the `!res` branch below already handles -- a non-compliant probe
  // agent must not crash the sequential revert-probe loop.
  let res = null
  try {
    res = await askAgent(revertProbePrompt(t), { label: 'probe:' + t.id, phase: 'Mutation probe', model: M.haiku, effort: CFG.effort.probe, schema: REVERT_PROBE_SCHEMA })
  } catch (e) {
    res = null
  }
  if (!res) {
    return {
      ...t,
      status: 'open',
      blocked: true,
      clean: false,
      probe: null,
      rulings: [makeRuling(t.id, 'unverified', 'the revert-probe agent died or was skipped', 'a real restore failure, or a test that does not actually catch this fix, could go undetected')],
      blockerFindings: [
        {
          file: '(mutation)',
          severity: 'blocker',
          phase: 'Mutation probe',
          summary: 'Task ' + t.id + '\'s revert-probe agent died or was skipped.',
          detail: 'no evidence exists that "' + t.test + '" actually catches, or that "' + t.file + '" was restored after, this probe',
        },
      ],
    }
  }
  const blockerFindings = []
  if (res.fallback !== 'untracked' && !res.caught) {
    blockerFindings.push({
      file: '(mutation)',
      severity: 'blocker',
      phase: 'Mutation probe',
      summary: 'Test "' + t.test + '" did not fail when the fix in ' + t.file + ' was reverted -- it does not actually cover the fix.',
      detail: res.evidence || '(no evidence reported)',
    })
  }
  return { ...t, status: blockerFindings.length ? 'open' : 'complete', clean: !blockerFindings.length, probe: res, blockerFindings }
}
function checksumAfterPrompt(files) {
  return [
    'You are a mechanical checksum recorder, read only. Compute `git hash-object <file>` for each file below and report it exactly.',
    ...files.map((f) => '- ' + f),
    'Rules: read only -- do NOT modify, create, delete, format or restore any file, and do NOT run tests, builds, or installs. Report each digest as lowercase hex; the exact string "unreadable" if the file could not be read.',
    'Context: these files were deliberately reverted and then restored by other agents. Your digests are the independent evidence of whether the restore actually happened -- they are compared, IN SCRIPT, against the digests recorded for these same files before any of this ran.',
  ].join('\n')
}
endPhase('Implement')
startPhase('Mutation probe')
const revertProbeTasks = tasks.filter((t) => t.type === 'revert-probe')
let mutationProbe = { ran: false, skipped: 'no-revert-probe-tasks', probed: 0, allCaught: null, restoredVerified: null, results: [] }
if (revertProbeTasks.length) {
  const probedResults = []
  for (const rt of revertProbeTasks) {
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential
    const probed = await runRevertProbeTask(rt)
    probedResults.push(probed)
    resultsById.set(rt.id, probed)
  }
  taskResults.push(...probedResults)
  // Exactly ONE checksum:after call total, covering every probed file --
  // never one per probe -- compared IN SCRIPT (never the probe agents' own
  // self-reported restored:true) against the digest Baseline's manifest
  // already recorded for that file at the start of the run.
  const probedFiles = uniquePaths(revertProbeTasks.map((t) => t.file).filter(Boolean))
  // E8: same non-fatal treatment as runRevertProbeTask above -- restoredVerified
  // already tolerates a falsy afterRes.
  let afterRes = null
  try {
    afterRes = await askAgent(checksumAfterPrompt(probedFiles), { label: 'checksum:after', phase: 'Mutation probe', model: M.haiku, effort: CFG.effort.checksum, schema: CHECKSUM_SCHEMA })
  } catch (e) {
    afterRes = null
  }
  const afterMap = new Map((afterRes && Array.isArray(afterRes.files) ? afterRes.files : []).map((f) => [normPath(f.file), f.digest]))
  const beforeMap = new Map(manifestResult.files.map((f) => [f.path, f.digest]))
  let restoredVerified = !!afterRes
  const mismatches = []
  for (const f of probedFiles) {
    const k = normPath(f)
    const before = beforeMap.get(k)
    const after = afterMap.get(k)
    if (!before || !after || before !== after) {
      restoredVerified = false
      mismatches.push(f)
    }
  }
  if (!restoredVerified) {
    findings.push({
      file: '(mutation)',
      severity: 'blocker',
      phase: 'Mutation probe',
      summary: 'Revert-probe restore is UNVERIFIED for: ' + (mismatches.length ? mismatches.join(', ') : '(the checksum:after agent died or was skipped)'),
      detail: 'the in-script comparison of `git hash-object` digests -- Baseline\'s recorded digest vs this checksum:after agent\'s -- did not match, or no after-digest exists. Never trust a probe agent\'s own restored:true self-report as the sole evidence.',
    })
  }
  mutationProbe = {
    ran: true,
    skipped: null,
    probed: probedResults.length,
    allCaught: probedResults.every((r) => r.probe && (r.probe.caught || r.probe.fallback === 'untracked')),
    restoredVerified,
    results: probedResults.map((r) => r.probe),
  }
}
endPhase('Mutation probe')
// The A10b ui-reverify pass below makes real 'ui-redrive:'/'ui-rejudge:'
// agent calls, but not inside any sandbox `phase()` bracket of its own -- it
// conceptually belongs with the per-task chain (re-running a task's own UI
// verification after a fix round touched its files), so its tokens are
// folded into 'Implement' via overlappedWith, same as every other per-task
// chain stage; ending the Mutation probe bracket HERE (before this pass
// runs) keeps that phase's own measured tokens limited to its actual probe/
// checksum work.

// ---------- A10b: ui-verify re-run after an overlapping fix round ----------
// Fix round 1, finding 2: this must ALSO fire for the ui-verify task's OWN
// fix round, not only another task's -- a diff-reading re-review (the
// generic fixLoopStage/rereviewStage every task type shares) cannot confirm
// a console error, a blocked flow, a failed request, or an a11y violation
// actually cleared; ui-verify's whole purpose is that a diff read is not
// sufficient evidence for this task type. The fix is to unify the trigger,
// not build a second mechanism: `taskResults.some(...)` below used to
// exclude `other.id === t.id`, which is exactly why a same-task fix round
// never re-drove the browser. Dropping that exclusion means the SAME
// "this task's watched files just changed" check now also sees the task's
// own roundHistory (populated by its own fixLoopStage run earlier in this
// same wave loop, so the data is already there) -- re-driving unconditionally
// whenever ANY fix round (this task's own, or another's) touches a file
// this task watches, exactly as the reviewer recommended over trying to
// heuristically classify which findings were "UI-only".
for (const t of taskResults) {
  if (t.type !== 'ui-verify' || t.blocked) continue
  const uiFiles = new Set((t.files || []).map(normPath))
  if (!uiFiles.size) { t.reVerify = 0; continue }
  const overlaps = taskResults.some((other) => {
    return (other.roundHistory || []).some((rh) => {
      const fc = rh.exec && Array.isArray(rh.exec.filesChanged) ? rh.exec.filesChanged : []
      return fc.some((f) => uiFiles.has(normPath(f)))
    })
  })
  if (!overlaps) { t.reVerify = 0; continue }
  const priorFindings = t.review && Array.isArray(t.review.findings) ? t.review.findings : []
  // eslint-disable-next-line no-await-in-loop
  const evidence2 = await askAgent(uiDrivePrompt(t, t.uiCfg, priorFindings), { label: 'ui-redrive:' + t.id, phase: 'UI verify', model: M.sonnet, effort: CFG.effort.uiDrive, schema: UI_EVIDENCE_SCHEMA })
  t.reVerify = 1
  if (!evidence2) {
    findings.push({
      file: '(ui-verify)',
      severity: 'blocker',
      phase: 'UI verify',
      summary: 'Task ' + t.id + '\'s UI re-drive died after a fix round touched files it watches.',
      detail: 'no fresh browser evidence exists after the fix -- treat the change as unverified, not clean',
    })
    continue
  }
  t.evidence = evidence2
  const model2 = isHighRisk(t) ? M.opus : M.sonnet // second UI judge on HIGH: Opus (ruling 2026-09-13)
  // eslint-disable-next-line no-await-in-loop
  const review2 = await askAgent(fableSafe(model2, uiJudgePrompt(t, t.uiCfg, evidence2, priorFindings)), { label: 'ui-rejudge:' + t.id, phase: 'UI verify', model: model2, effort: CFG.effort.review, schema: REVIEW_SCHEMA })
  if (review2) {
    t.review = review2
    // Fix round 2, finding 2 (cause a): every OTHER findings-merge site in
    // this file routes a review's raw severity ('critical'/'important'/
    // 'minor') through mapReviewSeverity before it reaches the run-wide
    // findings[] result.clean (~below) strictly checks severity==='blocker'
    // on -- this push used to skip that mapping, so a real disagreement
    // reported as raw 'critical' was invisible to result.clean.
    const mapped = (Array.isArray(review2.findings) ? review2.findings : []).map((f) => ({ ...f, severity: mapReviewSeverity(f.severity), phase: 'UI verify', source: 'ui-reverify' }))
    findings.push(...mapped)
    // Fix round 2, finding 2 (cause b): a genuine ui-reverify disagreement
    // (mapped to blocker or major) must also flip THIS task's own
    // status/clean -- not just add an entry to the run-wide findings[] --
    // because anyTaskNotClean (below) reads tr.status/tr.clean per task, and
    // progressLineFor()/the checkpoint already fired for this task in
    // runTask (before this post-loop pass ever runs) captured a frozen
    // "review clean" progress line that a later mutation to t.review cannot
    // retroactively correct. Mutating t.status/t.clean here IS still in
    // time for anyTaskNotClean, which runs after this whole A10b loop --
    // but a fresh, explicit checkpoint is fired too (the same append-only
    // fireCheckpoint pattern the sibling sweep uses below) so the
    // progress ledger itself carries the corrected line, rather than
    // leaving the stale one from the per-task checkpoint as the only record.
    const disagreement = mapped.some((f) => f.severity === 'blocker' || f.severity === 'major')
    if (disagreement) {
      t.status = 'open'
      t.clean = false
      const line = 'Task ' + t.id + ': ui-reverify found a real disagreement after a fix round (' + mapped.filter((f) => f.severity === 'blocker' || f.severity === 'major').length + ' finding(s), not clean)'
      fireCheckpoint('checkpoint:' + t.id + ':ui-reverify', { task: t, progressLine: line })
    }
  }
}

// Merge every task's own findings into the run-wide findings/rulings --
// never silently discarded (brief F). critical/important survive only on a
// task that hit the fix-round cap (status:'open'); a 'complete' task's
// findings were all ADDRESSED, so nothing further is pushed for it besides
// its (non-blocking) minor findings.
function mapReviewSeverity(s) { return s === 'critical' ? 'blocker' : s === 'important' ? 'major' : 'minor' }
const rulings = []
for (const tr of taskResults) {
  if (Array.isArray(tr.blockerFindings)) findings.push(...tr.blockerFindings)
  if (Array.isArray(tr.packGaps)) findings.push(...tr.packGaps)
  if (Array.isArray(tr.minorFindings)) {
    for (const f of tr.minorFindings) {
      findings.push({ file: f.file, severity: 'minor', phase: 'Gate & Review', summary: f.summary, detail: f.scenario || f.detail || '' })
    }
  }
  if (tr.status === 'open' && Array.isArray(tr.remaining)) {
    for (const f of tr.remaining) {
      findings.push({ file: f.file, severity: mapReviewSeverity(f.severity), phase: 'Fix', summary: f.summary, detail: f.scenario || f.detail || '' })
    }
  }
  if (Array.isArray(tr.rulings)) rulings.push(...tr.rulings)
}
// Fix round 1, finding 5: an 'important' finding that survives the cap maps
// to 'major' (never 'blocker'), so the severity-only check below would miss
// it entirely. Run-level clean must also fail when any task's OWN status
// says it did not finish clean, independent of how its findings map.
const anyTaskNotClean = taskResults.some((tr) => tr.status === 'open' || tr.clean === false)

// Shared by the sibling sweep and Final pass below: true if any task this
// run touches is HIGH risk, explicit or from the Baseline manifest --
// isHighRisk() already implements exactly that rule.
const hasHighRiskTask = tasks.some((t) => isHighRisk(t))

// ---------- A11: post-loop sibling sweep (mode:'bugfix' only) ----------
// Adapted from pipeline.js.bak-2026-09-12 @1615 (siblingGrepPrompt) and
// @1628 (siblingJudgePrompt). args.siblingPatterns is the caller-supplied
// contract, unchanged from the old engine's shape.
function siblingGrepPrompt(patterns) {
  return [
    'You are the SIBLING SWEEP grepper -- mechanical and read-only. A defect is being fixed in this run; the patterns below name its SHAPE. Find every other place in this repository that matches, so a judge can decide which of them are the same bug in a second place. You judge NOTHING.',
    'Patterns -- run each one separately and report which pattern produced each hit:',
    ...patterns.map((p, i) => '  ' + (i + 1) + '. /' + p.pattern + '/' + (p.note ? ' -- ' + p.note : '')),
    'Use ripgrep (or `grep -rnE`) over the source tree, EXCLUDING node_modules, dist, build output and .next. Report each hit as its pattern, the repo-relative path, the line number, and the matching line verbatim (trimmed to about 200 characters).',
    'Cap each pattern at 40 hits: if one matches more, report the first 40 and name that pattern in truncated -- never silently drop the rest.',
    'Read only: do NOT modify, create or delete any file, and do NOT run builds, tests or installs.',
  ].join('\n')
}
function siblingJudgePrompt(patterns, hits) {
  return [
    'You are the SIBLING SWEEP judge. A defect is being fixed in this run. The hits below match its SHAPE elsewhere in the repository. Decide, for each hit, whether the same defect is live there.',
    'The patterns that produced these hits:',
    ...patterns.map((p, i) => '  ' + (i + 1) + '. /' + p.pattern + '/' + (p.note ? ' -- ' + p.note : '')),
    'Verdicts: "defect" = the same defect is live here, and you can state the concrete failure scenario; "same-class-but-guarded" = the shape matches but something already prevents the failure, and you can NAME that guard; "unrelated" = the match is incidental.',
    'Hits:',
    ...hits.map((h, i) => '[#' + i + '] ' + h.file + ':' + (h.line || '?') + ' -- ' + String(h.excerpt || '').slice(0, 200) + '   (pattern: ' + (h.pattern || '?') + ')'),
    'One verdict per index, each with ONE sentence of evidence and the severity it deserves. "same-class-but-guarded" requires the guard by name -- if you cannot name it, say "defect" instead.',
  ].join('\n')
}
startPhase('Verify')
const rawSiblingPatterns = Array.isArray(_args.siblingPatterns) ? _args.siblingPatterns : []
let siblingSweep = {
  ran: false,
  supplied: rawSiblingPatterns.length,
  patterns: 0,
  hits: 0,
  findings: 0,
  skipped: mode !== 'bugfix' ? 'feature-mode' : (rawSiblingPatterns.length ? null : 'no-patterns'),
}
if (mode === 'bugfix' && rawSiblingPatterns.length) {
  siblingSweep.patterns = rawSiblingPatterns.length
  const grep = await askAgent(siblingGrepPrompt(rawSiblingPatterns), { label: 'sibling-grep', phase: 'Verify', model: M.haiku, effort: CFG.effort.siblingGrep, schema: SIBLING_HITS_SCHEMA })
  if (!grep) {
    siblingSweep.skipped = 'grep-died'
  } else {
    const hits = (Array.isArray(grep.hits) ? grep.hits : []).filter((h) => h && h.file)
    siblingSweep.hits = hits.length
    if (!hits.length) {
      siblingSweep.ran = true
    } else {
      const judgeModel = hasHighRiskTask ? M.opus : M.sonnet // final-pass judge on HIGH: Opus (ruling 2026-09-13)
      const judged = await askAgent(fableSafe(judgeModel, siblingJudgePrompt(rawSiblingPatterns, hits)), { label: 'sibling-judge', phase: 'Verify', model: judgeModel, effort: CFG.effort.siblingJudge, schema: SIBLING_VERDICT_SCHEMA })
      if (!judged) {
        siblingSweep.skipped = 'judge-died'
      } else {
        const byIndex = new Map((Array.isArray(judged.verdicts) ? judged.verdicts : []).map((v) => [v.index, v]))
        let sibFindingCount = 0
        hits.forEach((h, i) => {
          const v = byIndex.get(i)
          if (!v || v.verdict !== 'defect') return
          sibFindingCount++
          const f = {
            file: h.file,
            line: typeof h.line === 'number' ? h.line : 0,
            severity: v.severity === 'blocker' || v.severity === 'minor' ? v.severity : 'major',
            summary: h.file + ':' + (h.line || '?') + ' -- ' + v.evidence,
            detail: v.evidence,
            phase: 'Verify',
            source: 'sibling-sweep',
          }
          findings.push(f)
          fireCheckpoint('checkpoint:sibling-sweep:' + i, { finding: f, progressLine: 'Sibling sweep: ' + f.file + ':' + f.line + ' -- ' + f.summary })
        })
        siblingSweep.ran = true
        siblingSweep.findings = sibFindingCount
      }
    }
  }
}
if (rawSiblingPatterns.length && mode !== 'bugfix') {
  log('Note: args.siblingPatterns is a BUGFIX-MODE argument -- this run is in feature mode, so no sibling sweep ran and the patterns were ignored')
}

// ---------- A12: Final pass ----------
function finalGatePrompt(commands) {
  return [
    'You are the FINAL gate. Run the full verification suite once, from the repo root, in order:',
    ...commands.map((c) => '- ' + c),
    'Rules: do NOT fix anything, do NOT create, modify or delete any file, and do NOT adjust or substitute a command that fails -- run each one EXACTLY as written.',
    'Report each command: pass:true only if it actually ran and succeeded; pass:false if it exits nonzero, errors, or cannot be run at all -- with the key error lines quoted verbatim in summary. Report `executed` and overall pass. Report the working directory you ran in as `cwd`.',
  ].join('\n')
}
function fableFinalReadPrompt(findingsSoFar) {
  return [
    'You are the FINAL READ over this run\'s accumulated findings and diff. This run touched at least one HIGH-risk file, which earns one more adversarial pass before the run reports itself done.',
    'Findings already recorded this run: ' + JSON.stringify(findingsSoFar),
    'Read the actual diff (`git diff` against the run\'s baseline) for anything those findings missed.',
    'Report ONLY genuinely new findings this run has not already recorded (severity critical|important|minor, file, line, summary, detail). An empty findings list is a good answer.',
  ].join('\n')
}
endPhase('Verify')
startPhase('Final pass')
const [finalGateResult, fableReadResult] = await parallel([
  () => (finalCmds.length ? askAgent(finalGatePrompt(finalCmds), { label: 'final-gate', phase: 'Final pass', model: M.haiku, effort: CFG.effort.baseline, schema: GATE_SCHEMA }) : Promise.resolve(null)),
  hasHighRiskTask ? () => askAgent(withToolCap(fableFinalReadPrompt(findings)), { label: 'final-read', phase: 'Final pass', model: M.fable, effort: CFG.effort.finalRead, schema: FINDINGS_SCHEMA }) : () => Promise.resolve(null),
])
if (finalCmds.length) {
  const problem = gateProblem(finalGateResult)
  if (problem) findings.push({ file: '(final-gate)', severity: 'blocker', phase: 'Final pass', summary: 'The final verify suite did not pass clean.', detail: problem })
}
if (hasHighRiskTask && fableReadResult && Array.isArray(fableReadResult.findings)) {
  findings.push(...fableReadResult.findings.map((f) => ({ ...f, phase: 'Final pass' })))
}
const finalPass = {
  ran: true,
  skipped: hasHighRiskTask ? null : 'no-high-risk',
  model: hasHighRiskTask ? M.fable : null,
  completed: finalCmds.length ? gateProblem(finalGateResult) === null : true,
}
endPhase('Final pass')

// A10b: the run-level uiVerify field, populated from every ui-verify task
// this run scheduled (instead of staying null) -- one task is the common
// case, so its evidence is reported directly; more than one reports an
// array so no evidence is silently dropped.
const uiTasks = taskResults.filter((t) => t.type === 'ui-verify')
const uiVerify = uiTasks.length
  ? { ran: true, reVerify: uiTasks.reduce((s, t) => s + (t.reVerify || 0), 0), evidence: uiTasks.length === 1 ? uiTasks[0].evidence : uiTasks.map((t) => t.evidence) }
  : null

// A13: drain every fire-and-forget checkpoint before this run reports itself
// done, so result.checkpoints[] (built above, inside checkpoint() itself) is
// always complete by the time a caller reads it -- never a race with a
// checkpoint agent that is still mid-flight.
await Promise.allSettled(pendingCheckpoints)

// ---------- A14: result assembly ----------
// phaseReport: EVERY title now goes through the same bracket (T2 cost-plan)
// -- the five run-level anchors via startPhase/endPhase around their single
// whole-run span, the other five via meterStage around each per-task stage
// call (chainForType, above). Each gets a real, measured tokens delta
// whenever its bracket closed clean, or an honest estUnknown:true (never a
// guessed number) when the reading was unavailable, stuck at the same value
// across real agent calls, or CONTAMINATED -- two tasks in the same wave
// entered the same titled stage concurrently, so budget.spent()'s one
// shared cumulative scalar cannot isolate either one's own delta.
// ANCHOR_PHASES still marks which five are non-overlapping spans: those
// five's per-task chain (Author tests/Red gate/Gate & Review/Fix/UI verify)
// physically runs INSIDE the single Implement bracket (the whole wave loop),
// so Implement's own delta already includes every one of their tokens --
// adding the non-anchor five into estimatedCostUsd too would double-count.
// They keep overlappedWith:'Implement' and stay OUT of the sum; their own
// tokens/estUsd are populated (when not unknown) purely for visibility, same
// philosophy as the old engine's markOverlapped. agents/rawFindings are real
// tallies for every title either way: phaseAgentCounts (every askAgent()
// call, instrumented at askAgent itself) and findings.filter(f => f.phase
// === title) (every finding actually recorded under that name).
const ANCHOR_PHASES = new Set(['Baseline', 'Implement', 'Mutation probe', 'Verify', 'Final pass'])
const PHASE_PRIMARY = {
  Baseline: { model: M.haiku, effort: CFG.effort.baseline },
  'Author tests': { model: M.sonnet, effort: CFG.effort.testAuthor },
  'Red gate': { model: M.haiku, effort: CFG.effort.redCheck },
  Implement: { model: M.sonnet, effort: CFG.effort.implement },
  'Gate & Review': { model: M.sonnet, effort: CFG.effort.review },
  Verify: { model: M.sonnet, effort: CFG.effort.siblingJudge },
  'UI verify': { model: M.sonnet, effort: CFG.effort.review },
  'Mutation probe': { model: M.haiku, effort: CFG.effort.probe },
  Fix: { model: M.sonnet, effort: CFG.effort.fixExec },
  'Final pass': { model: M.haiku, effort: CFG.effort.baseline },
}
const confirmedByPhase = {}
const phaseReport = PHASE_TITLES.map((title) => {
  const agents = phaseAgentCounts[title] || 0
  const rawFindings = findings.filter((f) => f.phase === title).length
  // No separate confirmation/refuter pass exists in this rebuild (one
  // adversarial reviewer per task decides directly) -- every finding
  // recorded under a phase IS this run's confirmed count for it.
  confirmedByPhase[title] = rawFindings
  const primary = PHASE_PRIMARY[title]
  const isAnchor = ANCHOR_PHASES.has(title)
  const s = phaseStats[title]
  // Known limitation (ENGINE-NOTES.md, 2026-09-10): budget.spent() silently
  // read 0 on 26% of phases in production -- it is still the best available
  // telemetry source (no per-call usage data exists anywhere else to sum
  // instead), and the field is honestly named estUsd/tokens rather than
  // claimed as ground truth, with pipeline-ledger.mjs layering real
  // --usage-based trueCostUsd on top. A STUCK reading -- budget.spent()
  // reports the identical value at both ends of this bracket, so tokens
  // computes to a false 0 even though real agent calls happened -- looks
  // identical to "this phase legitimately spent nothing" unless flagged.
  const stuckZero = !s.unknown && !s.contaminated && s.sum === 0 && agents > 0
  const estUnknown = s.unknown || s.contaminated || stuckZero
  const tokens = estUnknown ? null : s.sum
  const est = estUnknown ? null : estUsd(tokens, primary.model)
  const note = s.unknown
    ? 'budget.spent() reading unavailable for at least one bracket -- tokens unknown, not zero'
    : s.contaminated
      ? 'two or more tasks entered this phase concurrently in the same wave -- budget.spent() is one shared cumulative scalar, so no reliable per-phase delta exists here; tokens unknown, not zero'
      : stuckZero
        ? 'budget.spent() read the SAME value at both ends of this phase despite ' + agents + ' agent call(s) -- a known stuck-reading failure mode (ENGINE-NOTES.md 2026-09-10), tokens:0 here is not proof this phase was free'
        : isAnchor
          ? ''
          : 'runs nested inside the single Implement bracket (the whole wave loop) -- this tokens/estUsd figure is shown for visibility only and is ALREADY included in Implement\'s own total, so it is excluded from estimatedCostUsd (see overlappedWith) to avoid double-counting'
  return {
    phase: title,
    ran: agents > 0,
    agents,
    rawFindings,
    tokens,
    estUsd: est ? est.usd : null,
    estUsdApprox: est ? est.approx : null,
    estUnknown,
    model: primary.model,
    effort: primary.effort,
    overlappedWith: isAnchor ? null : 'Implement',
    note,
  }
})
// Only the five ANCHOR_PHASES are additive spans (see the big comment
// above) -- summing the other five in too would double-count tokens already
// captured inside Implement's own bracket. estUnknownPhases lists every
// anchor whose reading is missing/stuck/contaminated so a reader can tell
// estimatedCostUsd is a sum of KNOWN anchors, never a sum that silently
// treated an unknown as 0 (T2 cost-plan).
const anchorReports = phaseReport.filter((p) => ANCHOR_PHASES.has(p.phase))
const estUnknownPhases = anchorReports.filter((p) => p.estUnknown).map((p) => p.phase)
const estimatedCostUsd = Math.round(anchorReports.reduce((s, p) => s + (p.estUsd || 0), 0) * 100) / 100

// redGate: aggregated from the per-task RED checks (redCheckStage already
// attaches redAudit/redRun/redAttempts to every task it actually ran on --
// none, in a 'lean' profile run, since redCheckStage is a no-op there).
const redAudited = taskResults.filter((tr) => tr.redAudit)
const redProbedRepro = redAudited.filter((tr) => tr.type === 'repro-test')
const redGate = {
  ran: redAudited.length > 0,
  structurallyRed: redAudited.length ? redAudited.every((tr) => isStructurallyRed(tr.redRun, tr.redAudit)) : null,
  behaviorallyRed: redProbedRepro.length ? redProbedRepro.every((tr) => tr.behaviorallyRed !== false) : null,
  attempts: redAudited.reduce((s, tr) => s + (tr.redAttempts || 0), 0),
  audits: redAudited.map((tr) => ({
    taskId: tr.id,
    structurallyRed: tr.structuralRedAccepted ? true : isStructurallyRed(tr.redRun, tr.redAudit),
    structuralRedAccepted: !!tr.structuralRedAccepted,
    behaviorallyRed: tr.behaviorallyRed === undefined ? null : tr.behaviorallyRed,
    attempts: tr.redAttempts || 0,
    blockers: (tr.redAudit && tr.redAudit.blockers) || [],
  })),
}

// gate: the run's own overall pass/fail (Final pass's own gate command, if
// any, plus no outstanding blocker and no task left un-clean).
const gate = {
  pass: (!finalCmds.length || gateProblem(finalGateResult) === null) && !findings.some((f) => f.severity === 'blocker') && !anyTaskNotClean,
  results: finalGateResult && Array.isArray(finalGateResult.results) ? finalGateResult.results : [],
}

const riskSummary = {
  totalTasks: tasks.length,
  highRiskTasks: tasks.filter((t) => isHighRisk(t)).length,
  explicitHighRiskTasks: tasks.filter((t) => t.risk === 'HIGH').length,
  manifestHighRiskFiles: (manifestResult.files || []).filter((f) => f.risk === 'HIGH').length,
}

// fixRouting/fixPlanning: aggregated from every task's roundHistory (each
// round already retains its real {plan, design, exec} evidence -- Fix round
// 1, finding 11 -- specifically FOR this aggregation).
const fixRoutingRounds = taskResults.flatMap((tr) =>
  (tr.roundHistory || []).map((rh) => ({ taskId: tr.id, round: rh.round, model: (rh.plan && rh.plan.model) || null, designer: !!(rh.plan && rh.plan.designer) })),
)
const fixRouting = {
  totalRounds: fixRoutingRounds.length,
  sonnetRounds: fixRoutingRounds.filter((r) => r.model === M.sonnet).length,
  fableRounds: fixRoutingRounds.filter((r) => r.model === M.fable).length,
  designedRounds: fixRoutingRounds.filter((r) => r.designer).length,
}
const fixRounds = taskResults.length ? Math.max(0, ...taskResults.map((t) => t.rounds || 0)) : 0
const deferredDecisions = taskResults.flatMap((tr) =>
  (tr.roundHistory || []).flatMap((rh) =>
    (rh.design && Array.isArray(rh.design.decisions) ? rh.design.decisions : [])
      .filter((d) => d && d.action === 'defer')
      .map((d) => ({ taskId: tr.id, round: rh.round, key: d.key, reason: d.reason || '' })),
  ),
)
const fixPlanning = {
  enabled: fixRoutingRounds.some((r) => r.designer),
  rounds: fixRoutingRounds,
  deferred: deferredDecisions,
  // Not wired to fix-brief.mjs's own per-round {truncated} flag -- that
  // script's result is read but not retained on roundHistory today, and no
  // ledger consumer reads this sub-field, so it is left an honest false
  // rather than invented.
  briefTruncated: false,
}

// confirmedFindings: every finding this run's reviewers actually confirmed
// for a task, regardless of whether a later fix round resolved it --
// distinct from remainingFindings (still-open only). Reads tr.review.findings,
// which is the task's LATEST review pass, not necessarily its first: fixLoopStage
// now folds every round's re-review newFindings (critical/important -- the
// severities that actually entered the fix loop, never the filtered-out
// minors) back into the review it returns, so for a fix/docs/ui-verify task
// this is the UNION of every finding ever confirmed across every round, not
// just the initial pass (previously only the initial review.findings were
// read here, an unbounded undercount whenever a later round's re-review
// discovered something new -- see fixLoopStage's own comment). For a
// ui-verify task that the post-loop A10b pass re-drives (a fix round
// anywhere touched a file it watches), t.review is overwritten wholesale to
// that SECOND browser pass's own result (review2, set earlier above in the
// A10b loop) -- so confirmedFindings for a re-verified ui-verify task
// reflects the re-drive's own findings, not whatever fixLoopStage had
// accumulated for it beforehand.
const confirmedFindings = []
for (const tr of taskResults) {
  if (tr.review && Array.isArray(tr.review.findings)) {
    for (const f of tr.review.findings) confirmedFindings.push({ ...f, severity: mapReviewSeverity(f.severity), taskId: tr.id, phase: 'Gate & Review' })
  }
}

// tasks[]: every existing field taskResults already carries (every scenario
// that reads a deeper field off result.tasks[] keeps working) PLUS the two
// NEW summary fields S5 names.
function reportPathFor(t) {
  if (t.type === 'root-cause') return taskDir(t.id) + '/root-cause.md'
  if (t.type === 'repro-test') return taskDir(t.id) + '/tests-report.md'
  if (t.type === 'ui-verify') return taskDir(t.id) + '/ui-evidence.json'
  if (t.type === 'revert-probe') return null
  return taskDir(t.id) + '/report.md'
}
const tasksOut = taskResults.map((t) => ({
  ...t,
  reviewVerdict: t.review ? t.review.assessment || t.review.specCompliance || null : null,
  reportPath: reportPathFor(t),
}))

// T2 cost-plan: printed, not just carried in the payload -- a reader
// scanning run output (not the JSON) must not mistake estimatedCostUsd for
// a complete total when one or more anchor phases came back unknown.
if (estUnknownPhases.length) {
  console.log('estimate incomplete (phases: ' + estUnknownPhases.join(', ') + ')')
}

// Legacy/removed fields from the old engine: explicitly nulled (never
// simply absent), each with its own reason in legacyNotes rather than a
// silent gap.
const legacyNotes = {
  overlap: "old engine tracked Gate & Review/UI-verify wall-clock overlap explicitly; this rebuild expresses concurrency via phaseReport[].overlappedWith instead",
  verify: "old engine's Verify phase ran a location-check + per-file refuters + a tie-break vote; this rebuild's Verify phase is the bugfix-only sibling sweep (see result.siblingSweep) -- there is no equivalent verify-lens summary to report",
  cascadeAudit: 'old engine partitioned Gate & Review into a HIGH-risk cascade plus a sampled LOW-risk spot audit; this rebuild runs one adversarial reviewer per task, so there is no cascade to audit',
  escalation: 'old engine could skip review lenses under token pressure and record which; this rebuild has no lens fan-out to escalate or skip',
  lensesRun: "old engine ran up to seven review lenses per file; this rebuild runs one adversarial reviewer per task (see result.tasks[].reviewVerdict)",
  lensReport: 'see legacyNotes.lensesRun',
  radiusPack: "old engine built a separate radius-only pack section; this rebuild folds radius excerpts into review-pack.mjs's own --radius section, already part of pack.md",
  plausibleFindings: 'old engine quarantined a lens\'s low-confidence findings separately before a tie-break vote; this rebuild has one reviewer per task, so there is no separate plausible/quarantined split',
  quarantined: 'see legacyNotes.plausibleFindings',
}

const payload = {
  phaseReport,
  confirmedByPhase,
  confirmedFindings,
  baseline: baselineResult,
  manifest: manifestResult,
  harnessCheck,
  remainingFindings: findings,
  clean: !findings.some((f) => f.severity === 'blocker') && !anyTaskNotClean,
  tasks: tasksOut,
  rulings,
  checkpoints,
  mutationProbe,
  uiVerify,
  siblingSweep,
  finalPass,
  redGate,
  gate,
  riskSummary,
  fixRouting,
  fixRounds,
  fixPlanning,
  estimatedCostUsd,
  estUnknownPhases,
  pricesAsOf: CFG.prices.asOf,
  startedAt,
  mode,
  scale,
  runId,
  profile: profileName,
  // C6 (Task 42): approach names the METHODOLOGY (this engine vs
  // superpowers vs raw), never the bugfix/feature divergence -- that is
  // `mode`. This engine only ever produces dev-pipeline-approach runs, in
  // either mode, per the house "one shared engine, mode is the only
  // divergence" convention -- so this is a literal constant, not derived
  // from mode/scale/profile.
  approach: 'dev-pipeline',
  overlap: null,
  verify: null,
  cascadeAudit: null,
  escalation: null,
  lensesRun: null,
  lensReport: null,
  radiusPack: null,
  plausibleFindings: null,
  quarantined: null,
  legacyNotes,
}
const written = await runResult(payload)
const result = { ...payload, endedAt: (written && written.endedAt) || null }
return result
