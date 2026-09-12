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
pipeline's Baseline phase _before_ any agent writes a line; one that does not exist comes
back as a **major** finding on this artifact and is routed to a fixer. The only exception is
a path this change CREATES — say so where you name it, or the check cannot tell a new file
from a wrong one. Read the repo (`ls`, the package manifest's `scripts`, the test config)
instead of guessing.

---

## Preamble (small scale)

_OPTIONAL — the one-artifact mode. Fill this in and this file replaces `discovery.md` and
`spec.md`; then omit `discoveryPath`/`specPath` from the pipeline args. `test-plan.md` is
never absorbed. On major work DELETE this section — the real artifacts exist, and a second
copy of the requirements forks them._

- **Problem:** <what is broken or missing today — the symptom, not the fix>
- **Who hits it:** <the user or system affected, and how often>
- **Success signal:** <the one observable thing that is true afterwards and false now>
- **Requirements** _(the `R#` that each package's `satisfies:` and each `T#` point at)_:
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

_2–4 sentences. What we are building or fixing and why. Name the user-visible or
system-visible outcome, not the code._

<objective>

**In scope:** <…>
**Explicitly out of scope (the scope fence, from the spec's — or the Preamble's — non-goals):** <…>

---

## Constraints & conventions

_Facts the agents cannot discover from this file alone. Read the repo before filling
this in — its conventions win over any habit._

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

_Authored FIRST, before any implementation package runs. These agents write tests only —
no implementation code, no edits to source files. Each package writes the files named in
[test-plan.md](./test-plan.md); file lists here must be disjoint from each other and from
the implementation packages below._

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

**Red gate command** _(runs only these new tests; every one must fail on an assertion,
none may pass)_:

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

| WP  | satisfies | provenBy | dependsOn | Wave |
| --- | --------- | -------- | --------- | ---- |
| WP1 | R1, R2    | T1, T3   | —         | 1    |
| WP2 | R3        | T2       | WP1       | 2    |

Cross-check: every `R#` in the spec appears in some package's `satisfies:`, or is listed
as deliberately out of scope above. Every `T#` in the test plan appears in some package's
`provenBy:`.

---

## Acceptance criteria

_Numbered, checkable statements. The `spec-compliance` reviewer walks these one by one
against the diff — write them so pass/fail is unambiguous, and tie each to its R#._

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

_UI work only. Flows and assertions come from §8 of [test-plan.md](./test-plan.md) —
copy them, do not re-derive them._

- **URL:** `<url>`
- **Start command:** `<command, or none>` — whatever the agent starts, it must stop.
- **Flows:** <one line per flow, each with its assertion>
- **Viewports:** `<desktop | mobile | tablet>`
- **Checks:** `console-errors`, `network-failures`, `a11y`, `design-system`

---

## Risks & rollback

| Risk | Likelihood     | Blast radius                                               | Mitigation / what the reviewer should watch |
| ---- | -------------- | ---------------------------------------------------------- | ------------------------------------------- |
| <…>  | <low/med/high> | <money wrong / data lost / cross-boundary leak / cosmetic> | <…>                                         |

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

_Ready to copy into the Workflow call. `planPath` and a non-empty `packages` are the only
required keys — delete any other that does not apply. Each optional key's phase is skipped
silently when absent and reports `ran: false` in `phaseReport`, so a missing key never fails
the run; it just removes that evidence._

```js
{
  // ---- artifacts: pass PATHS, never paste content ----
  planPath: '.claude/pipeline/<YYYY-MM-DD>-<slug>/build-plan.md',   // REQUIRED
  // Omit the next two when the small-scale Preamble replaced them.
  discoveryPath: '.claude/pipeline/<YYYY-MM-DD>-<slug>/discovery.md',
  specPath: '.claude/pipeline/<YYYY-MM-DD>-<slug>/spec.md',
  uxSpecPath: '.claude/pipeline/<YYYY-MM-DD>-<slug>/ux-spec.md',
  testPlanPath: '.claude/pipeline/<YYYY-MM-DD>-<slug>/test-plan.md',
  designSystemPath: '.claude/pipeline/design-system.md',
  // Every path passed here is read by the Baseline grounding check; uxSpecPath OR
  // designSystemPath also appends the `design-system` review lens, at either scale.
  // The project's lessons register — every reviewer, refuter, fixer and the final pass
  // apply its entries. Omit only when the project has none.
  lessonsPath: '.claude/lessons/LESSONS.md',
  // ISO timestamp taken when the run is launched; echoed into the result so the
  // ledger can compute wall-clock (scripts cannot read the clock).
  startedAt: '<YYYY-MM-DDTHH:MM:SSZ>',

  // small = the base lenses merged into ONE reviewer, no refutation, no mutation probe.
  // major = 6 lenses (7 with a UX spec or design system), 2 refuters per finding, probes.
  scale: '<small|major>',
  workdir: '<optional worktree path>',   // every agent cd's here first
  // A FRESH worktree (or a rebase across a schema change) carries a stale generated client (ORM
  // or other codegen) — regenerate it (e.g. `npx prisma generate`) BEFORE launching. Otherwise
  // typecheck/test fail at Baseline, are excluded as broken commands rather than read as
  // defects, and this run ends up with no real gate.
  context: '<one line of task context>',

  // ---- test-first: authored BEFORE implementation ----
  // Optional per package, same as the work packages below: satisfies, provenBy,
  // dependsOn, effort, model. Effort: omit (= the engine's `medium` transcription
  // default); 'high' ONLY for the money / tenancy / auth package; 'low' for purely
  // mechanical packages. `model` upgrades the one risky package, never the fleet.
  // dependsOn here may name only other TP ids — TP and WP ids resolve in SEPARATE namespaces,
  // and a WP naming a TP (or vice versa) is a (build-plan) blocker. Phase order already runs
  // every test package before the first implementation wave, so a cross-set edge is never needed.
  testPackages: [
    { id: 'TP1', title: '<title>', files: ['<test file path>'], brief: '<what to assert and the oracle>' }
  ],
  // Skipped entirely unless `commands` is a non-empty array; `expect` defaults to 'fail'.
  redGate: { commands: ['<test command scoped to the new tests>'], expect: 'fail' },

  // ---- implementation (REQUIRED, non-empty) ----
  packages: [
    {
      id: 'WP1', title: '<title>',
      files: ['<path/a>', '<path/b>'],
      brief: '<what to do>',
      satisfies: ['R1', 'R2'],
      provenBy: ['T1', 'T3']
    },
    {
      id: 'WP2', title: '<title>',
      files: ['<path/c>'],
      brief: '<what to do>',
      dependsOn: ['WP1'],   // the ONLY ordering mechanism; disjoint packages share a wave
      satisfies: ['R3'],
      provenBy: ['T2'],
      effort: 'high',       // this package touches money/tenancy/auth; omit elsewhere (= medium)
      model: '<optional per-package upgrade for the one risky package>'
    }
  ],

  // ---- gates: every command must already exist in this repo ----
  // TIERED is the default shape: perRound = typecheck/lint scoped to the touched workspaces,
  // run after the implementation and each fix round; final = the full suite, run ONCE and
  // deciding the result (beside the final pass). A plain array re-runs the same commands
  // every round — slower for no more evidence. Size packages so no wave has one long pole.
  verifyCommands: { perRound: ['<scoped typecheck/lint>'], final: ['<full suite>'] },
  // Each command string is its OWN shell invocation and cwd RESETS between entries — so a `cd` must
  // share the entry with the command it scopes: 'cd apps/api && npx jest …' in ONE string. Splitting
  // them runs the command from the workdir root (measured: suites fail to LOAD, 0 tests). Never swap
  // '&&' for ';' (masks the first command's failure). If '&&' arrives entity-escaped ('&amp;&amp;'),
  // the defect is upstream: pass this args object as a real OBJECT, never a JSON string.

  // The exact formatter command for THIS repo, run by every agent that edits files.
  // Omit it and each agent looks up the repo's own formatter (and skips when there is none).
  formatCommand: '<e.g. npm run format>',

  // ---- UI verification / UI fixing ----
  // Its presence is the whole switch — every key below has a default (url is derived from
  // the repo's dev-server config). No uiVerify, no browser evidence at all.
  uiVerify: {
    url: '<url>',
    startCommand: '<command or empty>',   // whatever an agent starts, it must stop
    flows: ['<plain-language flow + its assertion>'],
    viewports: ['desktop'],
    checks: ['console-errors', 'network-failures', 'a11y', 'design-system']
  },

  // ---- test-quality oracle (major scale only) ----
  // `behavior` is what must stay TRUE in that file — the thing the named test claims to
  // prove. The probe agent chooses and injects the defect itself; never write a defect here.
  // A target is probed only when Baseline classed its file HIGH risk, or the red gate never
  // ran; a LOW-risk target is skipped as redundant with the red gate. Every skip is logged
  // and recorded — a skipped probe is NOT a passed one.
  mutationProbe: {
    targets: [
      { file: '<path>', behavior: '<the behavior this file must keep — what the named test proves>', test: '<test that must go red>' }
    ]
  }
}
```
