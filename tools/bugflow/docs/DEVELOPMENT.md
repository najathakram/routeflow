# Developing bugflow

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** whoever writes code inside
`tools/bugflow/` — the package's own contributor guide, not a guide to using it

This is how to work on bugflow itself: the target layout, the rule that keeps it extractable, the
design principles carried over from how the campaign tooling it replaces is already written, the
testing strategy (a fake `gh` boundary, contract tests for the state machine, a race harness for the
claim compare-and-swap), how the `.claude/` glue stays thin, versioning, its CI job, how the
repo-wide code-map and lessons routines apply to it, and its Definition of Done. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the three-layer design this package implements one layer of,
and [MIGRATION.md](MIGRATION.md) for how it replaces `scripts/campaign/bugs.mjs` and
`scripts/team/team.mjs`.

## Target layout

```
tools/bugflow/
├── bin/
│   └── bugflow.mjs             # #!/usr/bin/env node shim -> src/cli
├── src/
│   ├── cli.ts                  # argv parsing + dispatch, one module per CLI.md command
│   ├── gh.ts                   # the ONE gh() boundary — every `gh` invocation in the package
│   ├── config.ts               # loads + validates bugflow.config.json
│   ├── classify.ts             # ported classify() — reads carveOut patterns from config
│   ├── lifecycle.ts            # the state table (LIFECYCLE.md) as data + transition functions
│   ├── planning.ts             # attach-or-wave: connected components + greedy wave colouring
│   ├── claims.ts               # claim-comment grammar + compare-and-swap (CLAIMS-AND-LEASES.md)
│   ├── reg-token.ts            # ported reg-token.mjs
│   ├── normalize-evidence.ts   # ported normalize-evidence.mjs
│   └── commands/               # file.ts, triage.ts, brief.ts, next.ts, claim.ts, heartbeat.ts,
│                                # release.ts, start.ts, prove.ts, verify.ts, plan.ts, sync.ts,
│                                # reap.ts, snapshot.ts, check.ts, board.ts, import.ts, render.ts,
│                                # self-test.ts — one file per CLI.md entry
├── test/
│   ├── fixtures/                # recorded gh() responses, one directory per scenario
│   ├── *.spec.ts                # unit + contract + race specs, see Testing strategy
│   └── integration/             # BUGFLOW_INTEGRATION=1 lane against a throwaway repo
├── docs/                        # this document set
├── templates/                   # ISSUE_TEMPLATE.bug.yml, scheduled-task.SKILL.md, loop.md,
│                                 # routine-housekeeping.md, routine-triage.md
├── archive/                     # optional, owner's opt-out only — MIGRATION.md's reversible
│                                 # default is delete after a zero-diff import verification
├── bugflow.config.json          # THIS repo's config — RouteFlow-specific, never imported by src/
├── bugflow.config.example.json  # RouteFlow's own config, annotated; a neutral seed is derived
│                                 # from it only when the package is extracted
├── package.json                 # "name": "@routeflow/bugflow", "bin": { "bugflow": "bin/bugflow.mjs" }
├── jest.config.js
├── eslint.config.js             # flat config, extends @routeflow/eslint-config/base
├── CHANGELOG.md
└── README.md
```

Root `package.json`'s `workspaces` gains `tools/*` **at implementation time, not in this docs-only
change** — this document describes the shape a future PR builds, and nothing here edits that file
today.

## Separation rules and how they're enforced

The decision brief's hard rule: bugflow imports **nothing** from `apps/*` or `packages/*`; every
RouteFlow-specific fact lives in `bugflow.config.json`, read at runtime, never imported as code.
Two enforcement layers, belt-and-suspenders rather than either alone:

1. **`eslint.config.js`'s `no-restricted-imports`** (or the equivalent flat-config rule) blocking any
   import matching `apps/*`/`packages/*` by path, and any bare `@routeflow/*` specifier other than
   `@routeflow/eslint-config` and `@routeflow/typescript-config` (dev-only config packages carry no
   product logic, so depending on them doesn't violate the rule). Fast feedback in-editor and in
   `npm run lint`.
2. **A contract spec** (`test/no-app-imports.spec.ts`) that greps `tools/bugflow/src/**` for the same
   pattern and fails the build if ESLint was ever bypassed or misconfigured. This repo already has
   precedent for exactly this shape of test — `turbo.json`'s own comment on the `@routeflow/api#test`
   task names `apps/api/src/common/no-dead-deps.spec.ts` and `docs-truth.spec.ts` as specs that read
   structural facts (README.md, CLAUDE.md, other apps' directory trees) directly, the same idea
   applied here to import statements instead of prose claims.

The spec, not the lint rule, is what CI actually gates on — a lint warning can be suppressed inline;
a failing Jest spec cannot.

## Design principles

Carried over from how `scripts/campaign/bugs.mjs` and `scripts/team/team.mjs` are already written,
and from the house rules in the root `CLAUDE.md`:

- **Derive from facts, never from state.** `team.mjs`'s own header states this directly: "board
  position is DERIVED from real PR + CI + review facts, never authored. A lane you have to remember
  to set is a lane that will be wrong." `bugflow sync` is this principle applied to every label and
  Project field it writes — never trust a hand-set status as an input to anything.
- **Every write path asserts its own effect (L-067).** `bugs.mjs`'s header records the incident this
  guards against: two writers racing a read-modify-write silently reverted each other's update, with
  both gates green. A `bugflow` command that writes (`claim`, `prove`, `verify`, …) must re-read after
  writing and confirm ITS OWN change landed — never infer success from the call not throwing.
- **The irreversible step goes last in any multi-step write (L-068).** Validate everything first (the
  target file exists, the token matches, the claim is still live) before the one action that cannot be
  undone (posting the comment that finalizes a claim, closing an issue). Modelled on `bugs.mjs`'s
  `prove`/`discharge`, which validate the whole obligation before writing the ledger row — never the
  reverse order.
- **Never pipe a gate inside an `&&` chain; run gates bare.** A gate's real exit code must reach the
  caller directly — `| tail` returns tail's exit code, and a heredoc ends the chain early; both let a
  red gate through. `bugflow check` and `bugflow self-test` must be invoked standalone in CI.
- **Every guard states whether it fails open or closed, explicitly.** A guard that decides on string
  emptiness rather than the command's real exit status and payload shape can silently treat an error
  as "nothing to report" — per **L-058**, a guard must decide on the command's exit status and
  payload shape, never on string emptiness — say which way each one fails, in a comment beside it.

## Testing strategy

**Jest only** (CLAUDE.md's "DO NOT introduce" list rules out Vitest here same as everywhere else).

- **Unit tests over a fake `gh` boundary.** Every `gh` invocation in the package goes through the one
  `gh()` function in `src/gh.ts`; tests replace it with a recorded-fixture adapter (a real `gh …
  --json …` output captured once, replayed deterministically). No unit spec imports the real `gh.ts`
  un-mocked, and no unit spec makes a live network call.
- **Contract tests for the state machine** (LIFECYCLE.md's table). Per **L-036** (compacted to
  `.claude/lessons/ARCHIVE.md`, id retained) — "when the artefact
  under test is a state machine, the oracle must walk PATHS, not edges" — a spec that only checks
  each transition in isolation cannot catch a composite violation. Walk sequences:
  `ready→claimed→(release)→ready` must not resurrect the released claim's identity on the next
  `claim`; `done→(verify --result red)→regressed→(sync)→ready` must be asserted as one path, not
  three independent edge tests. Guard on durable evidence (the PR's merge commit, the deploy sha)
  rather than the label alone, the same lesson names as the fix.
- **Race tests for claim CAS with two simulated seats.** Two fake `gh()` adapters racing a `claim`
  call against the same fixture comment thread must resolve to exactly one winner (lowest live
  comment id — CLAIMS-AND-LEASES.md). Per **L-066**, synchronize the race with a deterministic clock
  or explicit signal, never a real `setTimeout`/sleep race — "a fixed delay is never a readiness
  signal," and a flaky race spec teaches people to skip the gate it is supposed to be.
- **Snapshot round-trip.** `bugflow snapshot` then re-deriving state from that export must reproduce
  the same label/status facts as the live source it was taken from — a property test over a
  generated set of issues, not one fixture.
- **`bugflow self-test`** is the package's own `npm run verify` step — the direct descendant of the
  legacy `bugs.mjs self-test` suite (CLI.md). Per **L-041**, a CI step's *own* conclusion
  is what proves it ran — assert the self-test step is `success`, never infer that from the job being
  green (a job is green when every real step was skipped).
- **No live GitHub in unit tests**, ever — that is what the integration lane below is for.
- **A small opt-in integration lane** (`test/integration/*.spec.ts`), gated behind
  `BUGFLOW_INTEGRATION=1`, exercising the real `gh` CLI against a throwaway repo named
  `qa-bugflow-*` (mirroring this repo's own test-tenant naming convention, extended to a disposable
  GitHub repo rather than a tenant). Never part of the default `npm test` or a required CI check —
  run manually, or on its own separate schedule.
- **Windows.** Per **L-055** — a repo-wide, already-paid-for lesson — never embed `<rootDir>` in a
  Jest `testMatch` glob when the path can contain a dot-directory; every worktree in this repo lives
  under `.claude/worktrees/<name>`, and `tools/bugflow` is developed inside exactly those worktrees,
  so the same picomatch-vs-backslash bug that silently matched zero tests in `apps/web` would hit
  here too. Use a relative `testMatch` scoped by `roots`, per `apps/web/jest.config.js`'s precedent.
- **Cross-platform scripts.** Any `tools/bugflow` npm script that sets an environment variable must
  go through a Node shim, never a `VAR=val` prefix or `sh -c`; npm runs package scripts through
  cmd.exe on Windows with no `script-shell` configured.

## How the `.claude/` glue stays thin

- Skills (`bug-registry`'s rewrite, `bug-pipeline`, `dev-pipeline`) call the CLI as a subprocess —
  `bugflow brief #N --json`, `bugflow file "…" …` — and never re-implement classification or
  lifecycle logic in a skill's own prose.
- `.claude/hooks/stop.mjs`'s Gate 4 (landed on `master` via PR #597, `10ddc3fa`, 2026-09-05) shells
  out to `bugflow sync --quiet` at cut-over, the same way it shells out to `bugs.mjs sync` today.
- `tools/bugflow/templates/` — the scheduled-task prompt, `loop.md`, the two Routine prompts — are the
  only place outside `tools/bugflow/` itself that names bugflow specifics beyond "call the CLI."
- This is the separation rule's other direction: `apps/*`/`packages/*` facts never flow into
  bugflow (enforced by the contract spec above); bugflow specifics leaking back OUT into `.claude/`
  glue is bounded by convention and review instead, since "this skill file only ever shells out to
  the CLI" isn't something a grep can prove as cleanly as an import statement can.

## Versioning

- Semver from the first commit (`0.1.0`); `CHANGELOG.md` in Keep-a-Changelog style; `bugflow
  --version` reads its own `package.json`.
- Because Routines clone the default branch fresh on every run and a Desktop task runs against
  whatever the developer's own checkout has installed (WORKERS.md), there is no separate "deploy" for
  bugflow — the version every worker runs is whatever `tools/bugflow/package.json` says on `master` at
  run time. A breaking CLI change (CLI.md) therefore needs the same care as any other trunk-based
  change here: there is no window where "the CLI documented" and "the CLI a live worker calls" can
  diverge, which raises the cost of merging a half-finished contract change to `master`.

## CI job

R20 decides this: a `bugflow` job **inside** the existing `.github/workflows/ci.yml`, path-filtered
to `tools/bugflow/**` — not a separate parallel workflow file, and not folded into the main `verify`
job either, so bugflow's CI can turn red without blocking on the whole monorepo's `verify`. The root
`verify` job already runs `npm run verify` — lockfile validation, lessons validation, the bug-hunt
self-test and scan, `turbo run check-types lint test --concurrency=2`, then `campaign-check.mjs`.
Once `tools/*` joins root
`workspaces`, `turbo run check-types lint test` picks up `tools/bugflow` automatically (`turbo.json`'s
task definitions are keyed by task name, not by package — no `turbo.json` edit needed unless
`tools/bugflow` needs package-scoped `inputs` the way `@routeflow/api#test` does today). Once
MIGRATION.md Step 5 retires `campaign-check.mjs`/`bugs.mjs`/`team.mjs`, `bugflow check`/`bugflow
self-test` replace that step in the main `verify` job outright rather than sitting beside it.

- Steps (the `bugflow` job): lint, typecheck, `bugflow self-test` — scoped to the package, not a
  full monorepo rebuild.
- Per **L-034**: once `tools/bugflow`'s tests run under Turbo, a scoped local run (`jest -t
  "some spec"`) can leave a stale cached "green" for the FULL suite — force execution (`turbo run
  test --force`, or `npx jest` directly inside `tools/bugflow`) before trusting a replayed pass
  during development. CI itself has no turbo cache (`turbo.json`'s own comment: no `TURBO_TOKEN`, no
  `actions/cache` of `.turbo`, fresh runners every time), so this is a local-dev trap only.
- Per **L-013**/**L-010**: a red CI job here might be an install-step flake or worker exhaustion, not
  a real regression — read which step failed before debugging the code.

## Code-map and lessons routines, applied to this package

- `.claude/code-map/` should gain an entry for `tools/bugflow` once real source exists — `VERIFY`
  whether that is its own area file (`tools.md`, alongside `api.md`/`web.md`/`mobile.md`/`packages.md`)
  or a section of an existing one; the code-map skill's convention is one area file per
  workspace/module, which argues for its own file.
- **A real gap to close when implementing this:** `.claude/hooks/stop.mjs`'s Gate 2 (code-map
  freshness) only treats a file as "code" when it matches
  `^(apps|packages|scripts)\/.*\.(ts|tsx|js|jsx|cjs|mjs|prisma)$` (`isCode()`, read directly from
  this worktree's `stop.mjs`) — **`tools/` is not in that alternation.** Two one-line changes close
  it: `isCode()`'s alternation extends to `^(apps|packages|scripts|tools)\/...`, **and** Gate 2b's
  own `git diff --name-only ${lastMap} HEAD -- apps packages scripts` pathspec gains `tools` too —
  extending `isCode()` alone still leaves Gate 2b blind to code committed (not just uncommitted)
  under `tools/bugflow/`. Land both one-liners in the same PR that adds real source here, not as an
  afterthought.
- Gate 3 (lesson capture) is unaffected by the gap above — it anchors on branch name (`fix/*`) and
  commit message (`fix:`), not file path, so a bugflow bug fix is caught the same as any other.
- Lessons stay in the one repo-wide `.claude/lessons/LESSONS.md` — no separate register for this
  package. A bugflow lesson just carries whatever category fits (`tooling`, `process`, …). The
  register is at its 40-entry cap today (`_meta.json` nextId 72) — recording a new bugflow lesson
  means compacting one existing active entry to `ARCHIVE.md` in the same edit, per the register's
  cap rules (see the `lessons-learned` skill), not appending past the cap.

## Definition of Done for a bugflow change

- A test exists that fails without the change (unit, over the fake `gh` boundary, or a contract/race
  spec where the change touches lifecycle or claims).
- `npx jest` scoped to `tools/bugflow`, and `bugflow self-test`, both green.
- Lint and typecheck green for the package.
- `test/no-app-imports.spec.ts` still passes — no new `apps/*`/`packages/*` import.
- `.claude/code-map/`'s bugflow entry updated (once the Gate-2 regex gap above is fixed, the hook
  reminds you; until then, do it anyway).
- A lesson recorded if this was a bug fix (Gate 3 catches this regardless of the gap above).
- `CHANGELOG.md` entry, plus a version bump if the observable CLI contract changed (a new command, a
  changed exit code or flag) — a pure internal refactor doesn't need one.
- If the change touches the claim/lease grammar or the state table, `CLAIMS-AND-LEASES.md` /
  `LIFECYCLE.md` are updated in the same PR — those documents are the contract, not a description
  written after the fact.

## Extraction path to a standalone repo

Because bugflow imports nothing from `apps/*`/`packages/*` (enforced above) and every piece of
`.claude/` glue only ever shells out to the CLI, extraction is meant to be mechanical:

1. Split `tools/bugflow/`'s history into a new repo (`git subtree split`, or an equivalent history
   filter).
2. Publish `@routeflow/bugflow` (a registry, or keep it a git dependency — not decided here).
3. In RouteFlow, replace the `tools/*` workspace entry with a normal dependency pin on the published
   package.
4. Keep `bugflow.config.json` and the thin `.claude/` glue exactly as they are — both already only
   know "call the CLI" and "read this repo's own config file," so neither needs to change when the
   package's own source moves to a different repo.
5. `bugflow.config.example.json` (shipped inside the package) becomes the seed for any other repo's
   own config the same way it seeds this one.

No RouteFlow code change beyond the one workspace-entry swap — that guarantee is exactly what the
separation rule and this document's Definition of Done exist to keep true release over release, not
just on the day this package is first written.

## Open questions

- `VERIFY:` whether `.claude/code-map/` gets a new `tools.md` area file or a section of an existing
  one.
- `tools/bugflow/archive/` is the owner's opt-out only — MIGRATION.md's reversible default is to
  delete the legacy records after a zero-diff `import --dry-run --diff` verification, not archive
  them.
- `VERIFY:` publish target for `@routeflow/bugflow` on extraction (a registry vs. staying a git
  dependency) — not needed until extraction is actually scheduled.
