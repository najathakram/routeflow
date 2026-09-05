# bugflow

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** RouteFlow developers, and anyone
setting up a desktop scheduled task or cloud Routine to work the bug queue

bugflow is RouteFlow's bug-tracking and fix-automation tool: it treats GitHub Issues as the
database, Claude Code on ordinary subscription seats as the workers, and the repository itself as
the law those workers operate under. This document is the front door to the rest of the set —
read it first, then follow the table at the bottom to whichever piece you actually need.

## What it is

Three layers, and nothing else:

1. **RECORD = GitHub.** One Issue per bug (type `Bug`); the issue number is the bug id. Batches
   are parent Issues (type `Batch`) with bugs as sub-issues. Dependencies use GitHub's native
   blocked-by/blocking. Labels are the source of truth; `bugflow sync` mirrors them into Projects
   v2 fields, which is the dashboard.
2. **WORKERS = Claude Code on subscription seats.** Desktop scheduled tasks on developer machines,
   cloud Routines for housekeeping/triage, later dedicated "fleet" seats. Capacity is a simple
   product: fleet seats × runs/day × first-pass success rate.
3. **LAW = the repo.** Hooks, the carve-out classifier, the proof gate, GitHub rulesets, the merge
   queue, CODEOWNERS, `.claude/loop.md`, skills. Workers run with no permission prompts, so every
   guard has to live in the repo or in GitHub's own settings — never in a human clicking "approve."

Why this shape, and what it replaces, is the whole subject of
[`docs/adr/0003-bugflow-github-native-bug-tracking.md`](../../docs/adr/0003-bugflow-github-native-bug-tracking.md).

## Non-negotiables

- **No Claude API, no Agent SDK, no GitHub-Actions-hosted agents.** Every worker is Claude Code
  running on a subscription seat — a desktop task, a cloud Routine, or a `/loop`/`/goal` session.
  If a design needs an API key, it is not a bugflow design.
- **RECORD is GitHub, full stop.** Never a bespoke JSONL ledger, never a second database — the
  problem this replaces was exactly a bespoke store that could not survive more than one machine
  writing to it at once.
- **LAW lives in the repo.** A guard a Routine could route around by skipping a step is not a
  guard; it has to be a required check, a ruleset, or something the CLI itself refuses to do.
- **bugflow imports nothing from `apps/*` or `packages/*`.** All RouteFlow-specific knowledge sits
  in `bugflow.config.json`; the package must be extractable to its own repo at any time with no
  code change. See [ARCHITECTURE](docs/ARCHITECTURE.md) for the full separation rules.

## Quick start — a developer

```bash
# 1. one-time: make sure gh is authenticated as YOUR github login
gh auth status

# 2. see what bugflow would offer you right now
node tools/bugflow/bin/bugflow.mjs next --seat <your-github-login>
```

To let it run unattended between your own sessions:

1. Open Code tab → Routines → New routine → **Local**.
2. Point Instructions at [`templates/scheduled-task.SKILL.md`](templates/scheduled-task.SKILL.md)
   (copy it to `~/.claude/scheduled-tasks/bugflow-worker/SKILL.md`, or paste its body directly).
3. Turn the isolated-worktree toggle **on** — a worker fixing a bug should never touch your own
   working tree.
4. Set a schedule (every 30 minutes is a reasonable start) and a permission mode.

Full walkthrough, including what "isolated worktree" actually isolates and how to read a run's
output: [WORKERS](docs/WORKERS.md) and [RUNBOOK](docs/RUNBOOK.md).

## Quick start — a routine

Cloud Routines are for housekeeping and triage, not for claiming and fixing bugs unattended at
first (see [ROADMAP](docs/ROADMAP.md) for when that changes):

1. Code tab → Routines → New routine → **Cloud**.
2. Prompt: [`templates/routine-triage.md`](templates/routine-triage.md) (classify newly-filed
   bugs) or [`templates/routine-housekeeping.md`](templates/routine-housekeeping.md) (`sync` +
   `reap` + `plan` on a cadence).
3. Trigger: **Schedule** (minimum interval one hour) — a routine never triggers off an issue event;
   only Pull request and Release events are available if you need one of those instead.
4. No connector beyond the repo itself is required; the Routine acts as the GitHub identity of the
   account that owns it.

## Documents in this set

| Document | Owns |
| -------- | ---- |
| [`docs/adr/0003-bugflow-github-native-bug-tracking.md`](../../docs/adr/0003-bugflow-github-native-bug-tracking.md) | Why GitHub Issues over the alternatives — the decision record |
| `README.md` (this file) | Orientation, non-negotiables, quick starts |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, boundaries, data flow, one bug's life, failure modes |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Every term used anywhere in this set, defined once |
| [`docs/CLI.md`](docs/CLI.md) | The command reference — the implementation contract |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Issue/label/field schema |
| [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md) | The status state machine, transition by transition |
| [`docs/CLAIMS-AND-LEASES.md`](docs/CLAIMS-AND-LEASES.md) | Claim CAS, lease, heartbeat, reap mechanics |
| [`docs/PLANNING.md`](docs/PLANNING.md) | The attach-or-wave batching/waving algorithm |
| [`docs/DASHBOARD.md`](docs/DASHBOARD.md) | GitHub Projects v2 field mapping |
| [`templates/ISSUE_TEMPLATE.bug.yml`](templates/ISSUE_TEMPLATE.bug.yml) | The GitHub issue form |
| [`bugflow.config.example.json`](bugflow.config.example.json) | Every config key, annotated |
| [`docs/WORKERS.md`](docs/WORKERS.md) | Desktop tasks, cloud Routines, `/loop`, `/goal` — in depth |
| [`docs/HARNESS.md`](docs/HARNESS.md) | Ralph tier vs. full tier routing and execution |
| [`docs/GUARDRAILS.md`](docs/GUARDRAILS.md) | Usage caps and safety limits, and what enforces each |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Staged rollout toward fleet seats |
| [`templates/scheduled-task.SKILL.md`](templates/scheduled-task.SKILL.md) | Desktop task prompt template |
| [`templates/loop.md`](templates/loop.md) | `.claude/loop.md` default prompt |
| [`templates/routine-housekeeping.md`](templates/routine-housekeeping.md) | Cloud Routine prompt — sync/reap/plan |
| [`templates/routine-triage.md`](templates/routine-triage.md) | Cloud Routine prompt — classify new bugs |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Day-to-day operator runbook |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Contributing to bugflow itself |
| [`docs/MIGRATION.md`](docs/MIGRATION.md) | Moving off the legacy in-repo registry / PR #597 |

## Open questions

- `VERIFY:` whether a root `npm run bugflow --` convenience script gets added once `tools/*`
  becomes a real workspace — explicitly out of scope for this docs-only change. The CLI entry point
  itself is decided: `tools/bugflow/bin/bugflow.mjs` (see [DEVELOPMENT](docs/DEVELOPMENT.md) for the
  full package layout).
- Every other open question is tracked in the document that owns the topic, not repeated here.
