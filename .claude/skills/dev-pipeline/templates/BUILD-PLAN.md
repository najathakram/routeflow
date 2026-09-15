# Build plan: <task title>

> **Stage S5 — "how".** Authored by Fable 5 on `<YYYY-MM-DD>`.
> Status: `DRAFT | APPROVED | IMPLEMENTED | CLOSED`
> Supersedes the legacy `PLAN-TEMPLATE.md`. Written AFTER
> [test-plan.md](./test-plan.md) — the tests decide the shape of the work, not the
> reverse.
> This file is the ONLY context the implementation and review agents receive. It must
> stand alone: no "the conversation", no "as discussed".
> Inputs: [discovery.md](./discovery.md) (why), [spec.md](./spec.md) (`R#`),
> [ux-spec.md](./ux-spec.md) (UI work only), [test-plan.md](./test-plan.md) (`T#`).
> On small work the Preamble below stands in for the first two — never for the test plan.

**Gate to pass before S6:** every work package declares `satisfies:` (R#s) and
`provenBy:` (T#s). A package that satisfies nothing is scope creep; a package proven by
nothing is unverifiable — fix the plan or the test plan, not the claim.

**Ground rule — nothing named here may be invented.** Every file path, directory, shell
command and package-manifest script in this file is checked against the repo by the
pipeline's Baseline phase *before* any agent writes a line; one that does not exist comes
back as a **major** finding on this artifact and is routed to a fixer. The only exception is
a path this change CREATES — say so where you name it, or the check cannot tell a new file
from a wrong one. Read the repo (`ls`, the package manifest's `scripts`, the test config)
instead of guessing.

---

## Preamble (small scale)

*OPTIONAL — the one-artifact mode. Fill this in and this file replaces `discovery.md` and
`spec.md`; then omit `discoveryPath`/`specPath` from the pipeline args. `test-plan.md` is
never absorbed. On major work DELETE this section — the real artifacts exist, and a second
copy of the requirements forks them.*

- **Problem:** <what is broken or missing today — the symptom, not the fix>
- **Who hits it:** <the user or system affected, and how often>
- **Success signal:** <the one observable thing that is true afterwards and false now>
- **Requirements** *(the `R#` that each package's `satisfies:` and each `T#` point at)*:
  - `R1` — <must; one checkable statement>
  - `R2` — <should; …>
- **Non-goals (the scope fence):** <what this change deliberately does not do>

**Sufficient when every one of these holds:** `scale: 'small'`; 1–2 production files
(the test files this plan itself mandates do not count toward the bound); no UI surface
added or changed; nothing in a HIGH-risk area (money/pricing/tax, auth/permissions, tenancy
or ownership scoping, migrations/schema, PII, payments); the problem is already agreed and
statable in one sentence; five requirements or fewer.

**Not sufficient — write the full artifact set** when any of those fails: 3+ files, a new
feature, a refactor, anything cross-cutting or irreversible, any HIGH-risk file (Baseline
classes it HIGH and every reviewer reads it at maximum depth, so thin framing is exactly
where those runs go wrong), any UI change (`ux-spec.md` stays mandatory), or a problem still
under debate. Compressing discovery you never did is not small scale, it is guessing.

---

## Objective

*2–4 sentences. What we are building or fixing and why. Name the user-visible or
system-visible outcome, not the code.*

<objective>

**In scope:** <…>
**Explicitly out of scope (the scope fence, from the spec's — or the Preamble's — non-goals):** <…>

---

## Constraints & conventions

*Facts the agents cannot discover from this file alone. Read the repo before filling
this in — its conventions win over any habit.*

- **Stack / framework:** <…>
- **Test runner and layout:** <exact runner, exact spec-file location and naming convention>
- **Lint / format rules that will fail the gate:** <…>
- **Existing patterns to copy rather than invent:** `<path — the file to imitate>`
- **Design system source:** [design-system.md](../design-system.md) or `<tokens/config path>` — new UI cites it; it does not invent tokens.
- **Must NOT change:** <files, public shapes, wire formats, on-disk data>
- **Do-not-introduce list (from the repo's own rules):** <…>
- **Landmines:** <known traps in this area of the codebase>

---

## Test packages

*Authored FIRST, before any implementation package runs. These agents write tests only —
no implementation code, no edits to source files. Each package writes the files named in
[test-plan.md](./test-plan.md); file lists here must be disjoint from each other and from
the implementation packages below.*

### TP1 — <title>
- **writes:** `<exact repo-relative test file path>`, `<…>`
- **tests:** T<n>, T<n>
- **brief:** <what each test asserts and the oracle for the expected value — restate it
  here; the agent does not get to invent the expected value>
- **must fail with:** <the assertion failure expected before implementation exists>

### TP2 — <title>
- **writes:** `<path>`
- **tests:** T<n>
- **brief:** <…>
- **must fail with:** <…>

**Red gate command** *(runs only these new tests; every one must fail on an assertion,
none may pass)*:

```bash
<exact command>
```

---

## Work packages

Rules:

- File lists across packages must be **DISJOINT**. Disjoint packages run in parallel;
  overlapping ones must be merged or split.
- **Never force ordering by inventing a fake file overlap.** Ordering is expressed with
  `dependsOn:` and nothing else. A padded file list makes an agent open a file it has no
  business editing, and serializes work that could have run in parallel.
- Each package must be independently implementable **from this file alone**.
- Mark mechanical work `effort: low`.
- For anything non-obvious — tricky logic, exact signatures, security-sensitive lines,
  money math, scoping clauses — write the **actual code** here. The implementer
  transplants it rather than reinventing it.
- Implementation packages must not edit the test files written by the test packages. If a
  test genuinely must change, say so explicitly here and say why.

### WP1 — <title>
- **files:** `<path/a>`, `<path/b>` (exact repo-relative paths)
- **satisfies:** R<n>, R<m>
- **provenBy:** T<n>, T<n>
- **dependsOn:** <none | WP#>
- **effort:** <omit | low>
- **brief:** <precisely what to do in this package>
- **exact code:**

```<lang>
<the actual code for the tricky part>
```

### WP2 — <title>
- **files:** `<path>`
- **satisfies:** R<n>
- **provenBy:** T<n>
- **dependsOn:** WP1
- **brief:** <…>

### Package map

| WP | satisfies | provenBy | dependsOn | Wave |
|---|---|---|---|---|
| WP1 | R1, R2 | T1, T3 | — | 1 |
| WP2 | R3 | T2 | WP1 | 2 |

Cross-check: every `R#` in the spec appears in some package's `satisfies:`, or is listed
as deliberately out of scope above. Every `T#` in the test plan appears in some package's
`provenBy:`.

---

## Acceptance criteria

*Numbered, checkable statements. The `spec-compliance` reviewer walks these one by one
against the diff — write them so pass/fail is unambiguous, and tie each to its R#.*

1. `R<n>` — <observable, checkable statement>
2. `R<n>` — <…>
3. <a criterion for the negative case: the thing that must still be refused>
4. <a criterion for deploy day: existing users and existing data behave as stated>

---

## Verification commands

**Check the repo's tooling before listing anything here — every command must already
exist** (read `package.json` scripts / the task runner / the CI config). An invented command
is a **major** grounding finding, and a command that already fails on the untouched tree is
excluded from the pass/fail decision by the Baseline gate — so the protection you thought
you had silently disappears.

Per round (cheap, runs after every implementation wave):

```bash
<command>   # e.g. type check
<command>   # e.g. lint
```

Final (runs once at the end):

```bash
<command>   # full test suite
<command>   # build
```

If nothing runnable exists in this repo, write `none` and say so — the run then relies on
review only, and that fact belongs in the risks section.

---

## UI verification

*UI work only. Flows and assertions come from §8 of [test-plan.md](./test-plan.md) —
copy them, do not re-derive them.*

- **URL:** `<url>`
- **Start command:** `<command, or none>` — whatever the agent starts, it must stop.
- **Flows:** <one line per flow, each with its assertion>
- **Viewports:** `<desktop | mobile | tablet>`
- **Checks:** `console-errors`, `network-failures`, `a11y`, `design-system`

---

## Risks & rollback

| Risk | Likelihood | Blast radius | Mitigation / what the reviewer should watch |
|---|---|---|---|
| <…> | <low/med/high> | <money wrong / data lost / cross-boundary leak / cosmetic> | <…> |

- **Rollback:** <how to revert — a revert of the diff, a flag flip, a reverse migration.
  Name the exact steps.>
- **Migration reversibility:** <the down path, or an explicit statement that there is none>
- **Feature flag / entitlement:** <the gate key, **and the UI or script that actually
  grants it** — a gate nothing can turn on is a self-inflicted outage. Confirm the
  granting path writes the exact key the gate reads.>
- **Deploy day:** <what existing users and existing rows do the moment this lands; whether
  a backfill is required>
- **Observability:** <what in the logs or metrics says this broke at 2am>

---

## Pipeline args

*Ready to copy into the Workflow call. `buildPlanPath` and a non-empty `tasks[]` are the only
required keys — delete any other that does not apply. Each optional key's phase is skipped
silently when absent, so a missing key never fails the run; it just removes that evidence.
**Transcription note:** each Test package (TP#) above merges into the matching Work package's
(WP#) task below as that task's `tests[]` — the engine has ONE task graph, not a separate
test/implementation id space; a task authors its own tests and its own implementation.*

```js
{
  // ---- artifacts: pass PATHS, never paste content ----
  buildPlanPath: '.claude/pipeline/<YYYY-MM-DD>-<slug>/build-plan.md',   // REQUIRED — task-brief.mjs/review-pack.mjs read it
  testPlanPath: '.claude/pipeline/<YYYY-MM-DD>-<slug>/test-plan.md',     // optional — cited in review-pack.mjs's Test-plan excerpt
  // The project's lessons register — every implementer, reviewer and fixer apply its entries.
  // Omit only when the project has none.
  lessonsPath: '.claude/lessons/LESSONS.md',
  // ISO timestamp taken when the run is launched; echoed into the result so the
  // ledger can compute wall-clock (scripts cannot read the clock).
  startedAt: '<YYYY-MM-DDTHH:MM:SSZ>',
  // Per-task artifacts (brief.md, tests-report.md, report.md, pack.md, fix-r<N>.md) and
  // checkpoints land under here.
  runDir: '.claude/pipeline/<YYYY-MM-DD>-<slug>',

  // small = the tighter Baseline plan-size cap; default profile 'lean' when no task/manifest
  // file is HIGH risk. major = the larger cap; default profile 'standard'.
  scale: '<small|major>',
  mode: '<feature|bugfix>',   // default 'feature'; 'bugfix' turns on Baseline's harness-integrity read + the post-loop sibling sweep
  profile: '<lean|standard>', // optional override of the scale/risk-derived default (dev-pipeline/SKILL.md S0)
  workdir: '<optional worktree path>',   // every agent cd's here first
  // A FRESH worktree (or a rebase across a schema change) carries a stale generated client (ORM
  // or other codegen) — regenerate it (e.g. `npx prisma generate`) BEFORE launching. Otherwise
  // typecheck/test fail at Baseline, are excluded as broken commands rather than read as
  // defects, and this run ends up with no real gate.
  context: '<one line of task context>',
  baselineSha: '<optional — review-pack.mjs diff base; default "worktree" diffs against HEAD>',
  // mode:'bugfix' only — an ENGINE step run once after every fix task's loop closes, never a
  // task type of its own.
  siblingPatterns: [
    { pattern: '<git grep -n -E pattern that matches the same bug class>', note: '<why this pattern matches it>' }
  ],

  // ---- the task graph (REQUIRED, non-empty) — ONE array; no separate test/implementation id space ----
  // dependsOn is the ONLY ordering mechanism; disjoint-file tasks in the same wave run in
  // parallel. `brief` names the R#s this task satisfies and the T#s it's proven by (carry the
  // coverage cross-check below into the text — the engine reads `brief`/`tests[]`, not separate
  // `satisfies`/`provenBy` keys).
  tasks: [
    {
      id: 'WP1', title: '<title>',
      type: 'feature',                    // feature (default) | root-cause | repro-test | fix | revert-probe | docs | ui-verify
      files: ['<path/a>', '<path/b>'],     // exact repo-relative paths this task owns
      tests: ['<test file path>'],         // from the merged TP section; name the T# each one proves in brief
      brief: '<what to do — satisfies R1, R2; provenBy T1, T3 — exact code for the tricky parts, <= 1.5 KB>',
      dependsOn: [],
    },
    {
      id: 'WP2', title: '<title>',
      files: ['<path/c>'],
      tests: ['<test file path>'],
      brief: '<what to do — satisfies R3; provenBy T2>',
      dependsOn: ['WP1'],                  // the ONLY ordering mechanism; disjoint tasks share a wave
      risk: 'HIGH',                        // this task touches money/tenancy/auth; omit elsewhere (Baseline classifies it, unknown = HIGH)
      model: '<optional per-task upgrade — normally omitted; a HIGH-risk task already routes to Fable>'
    },
    // A `ui-verify` task carries its own driver config on the task record — no separate top-level switch.
    {
      id: 'UI1', title: '<verify the flow>',
      type: 'ui-verify', files: [], tests: [], dependsOn: ['WP2'],
      url: '<url>', startCommand: '<command or empty>',   // whatever an agent starts, it must stop
      flows: ['<plain-language flow + its assertion>'],   // copy from test-plan.md §8, don't re-derive
      viewports: ['desktop'],
      checks: ['console-errors', 'network-failures', 'a11y', 'design-system'],
      brief: '<what this flow must do>'
    }
  ],

  // A bugfix chain (bug-pipeline plans emit this shape; a dev-pipeline plan uses it too when one
  // of its tasks IS a bugfix): every `fix` must depend, directly or transitively, on a
  // `root-cause` AND a `repro-test`; every `revert-probe` must depend on its `fix`. An unmet
  // ancestor is a `(build-plan)` blocker before any agent runs (mechanically checked).
  //   tasks: [
  //     { id: 'RC1', title: '<confirm the cause>', type: 'root-cause', files: [], tests: [], dependsOn: [],
  //       brief: '<reproduce the bug on the current tree and confirm the named cause with the smallest probe>' },
  //     { id: 'RT1', title: '<repro test>', type: 'repro-test', files: [], tests: ['<repro spec path>'], dependsOn: ['RC1'],
  //       brief: "<must fail on the bug's own wrong value — name the exact wrongValue the RED check greps for>" },
  //     { id: 'FIX1', title: '<the fix>', type: 'fix', files: ['<path>'], tests: [], dependsOn: ['RC1', 'RT1'],
  //       brief: '<the minimal correct change; a fix task has no tests of its own>' },
  //     { id: 'RP1', title: '<revert probe>', type: 'revert-probe', files: ['<path>'], tests: [], dependsOn: ['FIX1'],
  //       brief: '<the file to revert + the ONE test that must go RED reverted, then be restored>' },
  //   ]

  // ---- gates: every command must already exist in this repo ----
  // TIERED is the default shape: perRound = typecheck/lint scoped to the touched workspaces,
  // run after each task's implement/fix round; final = the full suite, run ONCE at Final,
  // deciding the result. A plain array re-runs the same commands every round — slower for no
  // more evidence. Size tasks so no wave has one long pole.
  verifyCommands: { perRound: ['<scoped typecheck/lint>'], final: ['<full suite>'] },
  // Each command string is its OWN shell invocation and cwd RESETS between entries — so a `cd` must
  // share the entry with the command it scopes: 'cd apps/api && npx jest …' in ONE string. Splitting
  // them runs the command from the workdir root (measured: suites fail to LOAD, 0 tests). Never swap
  // '&&' for ';' (masks the first command's failure). If '&&' arrives entity-escaped ('&amp;&amp;'),
  // the defect is upstream: pass this args object as a real OBJECT, never a JSON string.

  // The exact formatter command for THIS repo, run by every agent that edits files.
  // Omit it and each agent looks up the repo's own formatter (and skips when there is none).
  formatCommand: '<e.g. npm run format>',
}
```
