# Architecture

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** anyone implementing bugflow, or
deciding where a new piece of behavior belongs

bugflow is a thin CLI over three things that already exist: GitHub Issues, `gh`, and Claude Code.
This document draws the boundaries between its pieces, why they sit where they do, what one bug's
life looks like end to end, and what happens when each of the ways this can fail actually happens.

## Components and boundaries

```
┌───────────────────────────────────────────────────────────────────────┐
│ Claude Code surfaces  (WORKERS)                                       │
│  desktop scheduled task · cloud Routine · /loop · /goal                │
│  — no permission prompts; every guard below must not depend on one     │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ runs a prompt that shells out to
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│ .claude/ glue  (thin — RouteFlow-facing, NOT the tool itself)          │
│  skills (bug-registry-successor) · hooks (stop.mjs Gate 4:             │
│  reporting-only registry sync today; bugflow's `sync --quiet` replaces │
│  its call at cut-over) · loop.md · scheduled-task / routine prompt     │
│  templates                                                             │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ invokes the CLI, never reimplements it
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│ tools/bugflow  (product-agnostic core — @routeflow/bugflow)           │
│  CLI commands (CLI.md) · bugflow.config.json (ALL RouteFlow knowledge) │
│  own Jest tests · own CI job · own CHANGELOG + semver                  │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ gh api / gh issue / gh pr / gh project
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│ GitHub  (RECORD + half of LAW)                                        │
│  Issues · sub-issues · native dependencies · Projects v2 · rulesets    │
│  merge queue · required checks · CODEOWNERS                           │
└───────────────────────────────────────────────────────────────────────┘
```

The other half of LAW — hooks, the carve-out's config, the proof-gate wiring — lives in the
`.claude/` layer and the `tools/bugflow` core itself, not in GitHub; see
[GUARDRAILS](./GUARDRAILS.md) for the full list of what enforces what.

## Separation rules, and why

- **bugflow imports nothing from `apps/*` or `packages/*`.** It knows nothing about orders,
  invoices, tenants, or pricing as concepts — only as strings inside `bugflow.config.json`'s
  `carveOut`/`areas`/`hubFiles` maps. Swap that one file and bugflow points at a different product.
- **All RouteFlow-specific knowledge lives in `bugflow.config.json`.** The carve-out patterns, the
  area globs, the hub files, the seats and their caps — every fact that is true *because this is
  RouteFlow* sits in config, never in the CLI's own source.
- **The `.claude/` layer stays thin and shells out.** Skills, hooks, and prompt templates call the
  bugflow CLI; they do not reimplement any of its logic (label grammar, claim CAS, wave colouring)
  a second time in a different language. A second implementation is exactly how the legacy
  `team.mjs`/`bugs.mjs` claim-grammar drift happened — see
  [`docs/adr/0003-bugflow-github-native-bug-tracking.md`](../../../docs/adr/0003-bugflow-github-native-bug-tracking.md).
- **Why this buys extractability.** A package that imports nothing from the monorepo and reads all
  product knowledge from one config file can be copied to its own repo and published to its own
  npm registry with zero code changes — only the config travels with the product it was
  configured for. `bugflow.config.example.json` is RouteFlow's own config, annotated — its real
  values are this repo's real carve-out patterns, area globs, and seats, not placeholders;
  `bugflow.config.json` is copied from it verbatim, and a neutral extraction seed is derived from
  it (values blanked, comments kept) only when the package actually leaves this repo.
- **Own Jest tests, own CI job, own CHANGELOG + semver.** bugflow is versioned and tested as if it
  already lived in its own repository, because one day it may.

## Data flow: one command, end to end

```
developer / Routine / desktop task
        │  bugflow claim #412
        ▼
tools/bugflow CLI
        │  1. read bugflow.config.json (seats, allowedClasses)
        │  2. gh api …/issues/412/comments   (read: live claims)
        │  3. gh issue edit 412 --add-assignee <login>
        │  4. gh api …/issues/412/comments -f body=<claim comment>
        │  5. gh issue edit 412 --remove-label status:ready --add-label status:claimed
        ▼
GitHub Issue #412
        │  now carries: assignee=<login>, a claim comment, status:claimed
        ▼
next `bugflow sync` / `bugflow board` / Projects v2 view
        reads the same issue back — labels and comments ARE the state,
        there is no second store to fall out of sync with
```

Every write in the sequence above is a real `gh` call against GitHub's API; nothing is cached or
mirrored locally except the optional, explicitly-triggered `snapshot` export. There is exactly one
place state lives, which is the property the legacy design (a JSONL ledger to keep in sync with a
GitHub Issues board to keep in sync with markdown records) never had.

## One bug's life through the system

1. **Filed.** A human, a monitor, or an agent notices something wrong → `bugflow file` → Issue
   `#N`, `status:triage`.
2. **Triaged.** `bugflow triage #N` runs the carve-out classifier and sets `class`/`tier`/`area`/
   `harness` → `status:ready` (or `parked` if carved out, or `blocked` if an open blocker exists).
3. **Planned.** `bugflow plan` either attaches `#N` to an in-flight batch sharing its files, or
   groups it with other `ready` bugs into a new batch, and colours every batch into a wave.
4. **Offered.** A worker (desktop task, cloud Routine, or a `/goal` loop) runs `bugflow next
   --seat <login>` and is handed the head of wave 1.
5. **Claimed.** `bugflow claim` — CAS via comment id — → `status:claimed`.
6. **Started.** `bugflow start #N` records the branch/worktree → `status:in_progress`.
7. **Routed.** `harness:ralph` (agent-safe, ≤3 files, tier `t1`, no hub file) or `harness:full` (the
   `bug-pipeline` skill) picks up the fix — see [HARNESS](./HARNESS.md).
8. **Reviewed.** A PR opens with `Closes #N`; `bugflow sync` moves the bug to `status:in_review`.
9. **Merged, proven.** `bugflow check` has already required a passing `REG-#N` test in that PR's
   own CI run as a precondition of merge; once it merges, `bugflow prove` — called by the worker —
   records the proof, and `bugflow sync` derives `status:verifying` from it.
10. **Deployed, verified.** The deploy reaches SUCCESS and the post-deploy check/E2E run confirms
    the REG token live → `bugflow verify --result green` records it → `bugflow sync` derives
    `status:done`, issue closed.
11. **(If it slipped through.)** The REG token goes red post-deploy → `bugflow verify --result
    red` records it → `bugflow sync` derives `status:regressed` (severity bumped), back to `ready`
    at step 3 — same issue number, full history intact.

Full state definitions and every transition's exact trigger: [LIFECYCLE](./LIFECYCLE.md).

## Failure modes

| Failure | What happens | Mechanism that handles it |
| ------- | ------------ | -------------------------- |
| **Dead routine** — the app closes, the machine sleeps, a daily cap is hit, or a run simply crashes mid-fix | A claim sits unattended past its lease | [Lease](./GLOSSARY.md#lease) expiry is timestamp-based, not liveness-based; any other seat's `bugflow reap` releases it, from any machine, with no assumption the dead worker ever comes back. Claim identity (`login/host/worktree`) tells a human which machine went dark. |
| **Duplicate claim** — two workers claim the same bug within seconds of each other | Both post a claim comment | GitHub's server-assigned, totally ordered comment ids make "lowest live id wins" a real compare-and-swap (see [CLAIMS-AND-LEASES](./CLAIMS-AND-LEASES.md)); the loser's `bugflow claim` exits `3` and proceeds no further. |
| **Runaway usage** — a fleet seat or Routine burns unbounded subscription usage on one bug or one bad loop | A single run keeps iterating or keeps re-claiming | Per-seat `dailyClaimCap`, Ralph's `ralph.maxIterations` cap, a fixed max runtime, and "one batch per run" are all config/CLI-enforced limits — never left to a model's own judgment about when to stop. See [GUARDRAILS](./GUARDRAILS.md). |
| **Silent wrong close** — a bug marked fixed without a real regression test, or closed on a merge that later reverts | `status:done` would be a lie | `bugflow check`'s CI proof gate refuses to let `Closes #N` merge without a passing `REG-#N` test in that run; `bugflow verify` only records a deploy's outcome, and `bugflow sync` only derives `done` against an actual green deploy + post-deploy check, never from "PR merged" alone; a later failure re-opens as `regressed` rather than staying silently closed. |
| **Agent-vs-agent conflict** — two batches would edit the same file in parallel | Two workers could clobber each other's diff | `bugflow plan`'s wave colouring keeps any two batches sharing a non-hub file out of the same wave; in-flight batches are pre-coloured into wave 1 so their conflicts are never dropped mid-run. See [PLANNING](./PLANNING.md). |
| **Public-window exposure** — the repo is briefly public during the CI push/merge window (see the root `CLAUDE.md`'s deploy flow) | Anything written to an Issue during that window is as exposed as a committed file, since Issue visibility follows repo visibility | bugflow performs no visibility changes itself — that stays the existing watchdog script's job, unchanged. The house rule against naming a live client applies identically to Issue text as to committed files; `privacy.denylistEnv` keeps the actual denylist out of the repo (and therefore out of anything bugflow writes) entirely, read only from an env var / private source at `sync` time. |

## Claude Code surfaces, briefly

Four surfaces can drive `bugflow next` → fix → `bugflow start`/`claim`/`prove` cycles; each is
covered in full in [WORKERS](./WORKERS.md):

- **Desktop scheduled task** — a developer's own machine, Local Routine kind, isolated-worktree
  toggle on for bugflow work.
- **Cloud Routine** — Anthropic-managed, no permission prompts, triggered by schedule, an
  authenticated API fire, or a PR/Release GitHub event (never an issue event).
- **`/loop`** — session-scoped, for one session's own recurring cadence.
- **`/goal`** — drives a single session until a stated condition is met (e.g. "queue empty").

## Open questions

- `VERIFY:` whether Project v2 field writes (in `sync`/`plan`) go through `gh project item-edit` or
  a raw GraphQL call — `gh`'s Projects v2 subcommands are narrower than its Issues/PR ones as of
  this writing.
- `VERIFY:` the merge-queue-on-private-repos plan requirement named in the ADR — this affects
  whether `bugflow check` can be wired as a merge-queue gate immediately or only after a plan
  change.
