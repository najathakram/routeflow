# Glossary

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** anyone reading or writing any
other document in this set, or any bugflow issue/label/comment

This is the one place every term used across the bugflow document set is defined. Every other
document links back here instead of re-explaining a term. If a word here disagrees with how
another document uses it, this file is wrong and should be fixed — not the other way round.
Terms are alphabetical; a `#N` GitHub issue reference in an example is illustrative, not a real bug.

## approved:owner

The marker a human applies directly on GitHub (`gh issue edit <N> --add-label approved:owner`) to
unpark a carve-out bug — the one label no `bugflow` command ever writes on its own. The next
`bugflow sync` turns it into `status:ready` + `harness:full`. See [Carve-out](#carve-out),
[Parked](#parked).

## Area

A label namespace (`area:<name>`) computed from a bug's `## Files` list against
`bugflow.config.json`'s `areas` map — a glob-to-area lookup (e.g. `apps/api/src/orders/**` →
`orders`). `unknown` is the reserved fallback when `## Files` is empty. [PLANNING](./PLANNING.md)
uses it to decide which in-flight batch a new bug attaches to; `bugflow next --seat` uses it only
indirectly, through the batch a bug already belongs to.

## Attach

What `bugflow plan`'s Step 1 does when a newly-`ready` bug shares a file (same area) with an
in-flight batch: `--set-parent` onto that batch, immediately inheriting the batch holder's
assignee and `status:claimed` — no separate claim step. See [PLANNING](./PLANNING.md),
[CLAIMS-AND-LEASES](./CLAIMS-AND-LEASES.md).

## Batch

A group of `status:ready` bugs whose `## Files` lists overlap (excluding [hub files](#hub-file)),
represented as a GitHub parent issue of type `Batch` with the grouped bugs as sub-issues. Capped
at `batch.maxBugs` (default 4). Claimed, planned, briefed, and shipped as one unit — never a bare
bug once batched; a singleton with no hard-conflict edges is claimed directly
(`bugflow claim #N`) and gets no Batch issue at all. See [PLANNING](./PLANNING.md),
[CLI § plan](./CLI.md#bugflow-plan---dry-run).

## Bug

One GitHub Issue, type `Bug`. The issue number is the bug id (`#N`). A bug imported from the
legacy in-repo registry keeps its `[B###]` title marker so its old `REG-B###` proof token keeps
matching (see [REG token](#reg-token)). The issue body carries a `## Files` list — the single
piece of input every batching and waving decision reads. See [DATA-MODEL](./DATA-MODEL.md).

## Carve-out

The classifier that marks a bug `class:money`, `class:tenancy`, or `class:migration` when its
title or `## Files` list matches owner-defined patterns (`bugflow.config.json`'s `carveOut`) — a
direct port of the legacy `classify()` function in `scripts/campaign/bugs.mjs`, whose own surface
was title + location; bugflow deliberately widens it to title + Files, since it has no `location`
field. Any of those three
classes forces `status:parked` until a human applies `approved:owner`. Deliberately over-broad: a
false "sensitive" costs one glance, a false "safe" costs a production incident. See
[LIFECYCLE](./LIFECYCLE.md).

## Claim

A GitHub assignee (the seat's own login) plus a lease comment recording who holds a bug or batch
and until when — what CLI command `claim` writes. Resolved by compare-and-swap on GitHub's
server-assigned, totally ordered comment ids: the lowest live comment id wins, which is a real CAS
because the ordering comes from GitHub's server, never from any client's clock. See
[CLAIMS-AND-LEASES](./CLAIMS-AND-LEASES.md).

## Class

The carve-out's own label namespace: `class:agent-safe | money | tenancy | migration`. Cardinality
is 1 `agent-safe`, **or** 1–3 carve-out classes together (a bug can trip both `money` and `tenancy`
at once) — never both an `agent-safe` and a carve-out class on the same bug. A seat's
`allowedClasses` (in `bugflow.config.json`) is checked against this label before a bug counts as
[takeable](#takeable) for that seat. See [Carve-out](#carve-out).

## Desktop task

A Claude Code Routine of kind **Local** — created from Code tab → Routines → New routine, running
only on the machine that created it, only while the app is open and the machine is awake. Carries
a schedule, a permission mode, a working folder, and an isolated-worktree toggle; its prompt lives
at `~/.claude/scheduled-tasks/<name>/SKILL.md`, so it can be templated and checked into the repo
(see [`templates/scheduled-task.SKILL.md`](../templates/scheduled-task.SKILL.md)). The primary
bugflow worker surface today. See [WORKERS](./WORKERS.md).

## Fleet seat

A Claude Code subscription seat dedicated to bugflow work on a standing basis — the future-state
worker beyond a developer's own desktop task or an ad-hoc cloud Routine. Capacity is a straight
multiplication: throughput ≈ fleet seats × runs/day × first-pass success rate. See
[ROADMAP](./ROADMAP.md), [WORKERS](./WORKERS.md).

## /goal

A Claude Code slash command that keeps a session working until a Haiku evaluator judges a stated
condition met (e.g. "the ready queue for `area:api` is empty"), optionally bounded by a turn
count. One way to drive a session through several `bugflow next` → fix → `bugflow start` cycles
without a human re-prompting each one.

## Harness

Which of the two execution tiers ([Ralph tier](#ralph-tier) or [Full tier](#full-tier)) picks up a
claimed bug — computed by `bugflow triage` from class/tier/file-count/hub-file membership and
written as the `harness:` label. See [HARNESS](./HARNESS.md).

## Heartbeat

Extending a live claim's lease by editing the *same* claim comment in place — never by posting a
new one, which would create a second, ambiguous claim record. Keeps a long-running full-tier fix
from being [reaped](#reap) mid-work. `bugflow heartbeat #N`.

## Hub file

A path `bugflow.config.json`'s `hubFiles` names as touched by so many bugs that sharing it is not
a meaningful conflict signal (e.g. `orders.service.ts`, `invoices.service.ts`, `schema.prisma`).
Two batches sharing only a hub file are not hard-conflicted and may share a [wave](#wave); sharing
any other file, they may not. See [PLANNING](./PLANNING.md).

## Lease

The time a [claim](#claim) stays valid before [reap](#reap) may release it — `lease.minutes` in
config, default 90 (minutes). Lease-time-based, not process-liveness-based: the one part of the
legacy design (`scripts/team/team.mjs`) that was already correct across machines, because a
comment's timestamp means the same thing everywhere, unlike a local process id.

## /loop

A session-scoped Claude Code command (`CronCreate`; 7-day expiry; at most 50 scheduled tasks) that
re-runs a prompt or slash command on an interval inside one running session. `.claude/loop.md`
holds the project's default maintenance prompt. Shorter-lived and more local than a
[routine](#routine) — useful for one working session's own cadence, not for unattended
multi-day operation.

## needs:human

A 0-or-1 marker meaning a worker cannot move this bug further without a person: applied by
`release` on a Ralph-tier cap-out, or by `sync` on an anomaly it cannot resolve on its own (two
qualifying open PRs, an assignee/lease mismatch, or a housekeeping [Witness](#witness) finding).
Excludes a bug from [Takeable](#takeable) until a human clears it — directly, or by re-triaging to
`harness:full`.

## Parked

The status held by a bug or batch the [carve-out](#carve-out) flagged, from the moment it is
classified until a human applies `approved:owner`. A parked bug is still planned and briefed —
never left uninvestigated — but no seat may claim it.

## Proof

Evidence that a fix actually fixes the bug: a test carrying the exact [REG token](#reg-token) for
that bug, which must fail on the bug's own wrong value before the fix exists and pass after.
`bugflow check` — the CI proof gate — refuses to let a `Closes #N` PR merge without one present
and passing.

## Proven vs. done

Two states that stay deliberately un-collapsible. `verifying` means a PR merged and CI showed a
passing REG-tagged test; `done` means a deploy carrying that merge reached SUCCESS and the
post-deploy check confirmed it live. Collapsing "merged with a green test" into "fixed in
production" is exactly the fiction the legacy `scripts/campaign-check.mjs` — and `bugflow
check`/`bugflow verify` after it — exist to prevent.

## Ralph tier

The harness route (`harness:ralph`) for a bug that is `class:agent-safe`, `tier:t1`, touches at
most `ralph.maxFiles` files (default 3), and touches no hub file: read the brief, write the
failing REG test, make the minimal diff, run scoped checks, open the PR, repeat up to
`ralph.maxIterations` (default 8) times, then release with `needs:human` and an attempts comment
if still not green. Named for the reproduce → root-cause → minimal-fix → regression-test → verify
loop. See [HARNESS](./HARNESS.md).

## Full tier

The harness route (`harness:full`) for anything Ralph's shape doesn't fit — a parked-and-approved
class, more files than `ralph.maxFiles`, a tier other than `t1`, or a hub file. Executed by the
existing `bug-pipeline` skill in full: an evidence brief, an adversarial cause refutation, one fix
ruling, repro-first tests, then the shared `dev-pipeline` engine in bugfix mode. See
[HARNESS](./HARNESS.md).

## REG token

The proof citation format: `REG-#{n}` for a bug filed natively as a GitHub issue, `REG-B{n}`
accepted for a legacy bug that kept its `[B###]` title through import. Matched as an exact token,
never a prefix — a test asserting `REG-12` must never be satisfied by one literally named
`REG-120`.

## Reap

Releasing every lease whose deadline has passed, from any machine, regardless of which session or
seat created it. `bugflow reap`. Safe to run anywhere at any time because leases are
timestamp-based, not liveness-based — there is no local process to check, unlike the legacy
lockdir mechanism it replaces (see [`docs/adr/0003-bugflow-github-native-bug-tracking.md`](../../../docs/adr/0003-bugflow-github-native-bug-tracking.md)).

## Resolution

The `resolution:` marker (`wontfix | duplicate | cannot-reproduce`) on an issue closed
not-planned — always paired with `status:done`, and always applied by a human, directly or via
`triage` on an evidence-backed already-fixed/refuted finding; no command writes it unattended. See
[CLI § Labels it may write](./CLI.md#labels-it-may-write).

## Regressed

A `done` bug whose REG proof failed again after deploy — the post-deploy check or a scheduled E2E
run went red on that specific token. Reopened with severity bumped and returned to `ready`; it
keeps its original issue number and full history rather than being re-filed under a new one.

## Routine

A Claude Code automation that runs a prompt on a schedule or trigger with no permission prompts.
Two kinds matter to bugflow: [desktop scheduled tasks](#desktop-task) (local, one developer's
machine) and **cloud Routines** (Anthropic-managed, research preview; triggers are Schedule, an
authenticated API fire, or a Pull-request/Release GitHub event — never an issue event). See
[WORKERS](./WORKERS.md).

## Seat

One Claude Code subscription identity — a `login` entry in `bugflow.config.json`'s `seats` map,
carrying an `allowedClasses` list and a `dailyClaimCap`. A [fleet seat](#fleet-seat)'s allowed
classes are `agent-safe` only.

## Severity

The `severity:` label namespace: `critical | high | medium | low`. Set by `bugflow file` from the
reporter's own claim, reconciled by `bugflow triage`; bumped one rank (never downgraded — `critical`
stays `critical`) by `bugflow sync` when a bug enters [Regressed](#regressed).

## Snapshot

`bugflow snapshot`'s export of current issue state to `snapshot/issues.jsonl` (full replace) plus
an append to `snapshot/events.jsonl`, committed to the dedicated `claude/bugflow-snapshot` branch.
A point-in-time, git-diffable mirror of state that otherwise lives only inside GitHub's own API.

## Source

The `source:` label namespace: `owner | monitor | customer | agent` — who or what noticed the
defect, set once at filing time (`bugflow file --source <s>`) and never changed afterward.

## Spike

A pass/fail proof-of-concept run before Stage 1 relies on a mechanism at all (S1–S5 in
[ROADMAP](./ROADMAP.md)) — e.g. confirming a cloud Routine can actually push to a
`claude/`-prefixed branch. Not a design exercise: a spike either passes, or the design underneath
it needs rethinking before Stage 1 starts.

## Sync

`bugflow sync`, the idempotent command that derives status labels and Project v2 fields from
PR/CI/deploy/blocker/lease facts — never the reverse. The generalization of two legacy mechanisms
in one: `bugs.mjs sync` (a record follows its ledger) and `team.mjs board` (a lane is derived from
live PR/CI state, never hand-set).

## Takeable

The one predicate a worker may act on: `status:ready`, no assignee, no open blocked-by, not
`parked`, no `needs:human` label, and a [class](#class) the seat is allowed to touch (a fleet
seat: `agent-safe` only). `needs:human` is cleared only by a human — directly, or by re-triaging
to `harness:full` — never by re-claiming or waiting it out. `bugflow next` returns the head of
wave 1 among the batches that are currently takeable and unclaimed for the calling seat.

## Tier

The `tier:` label namespace: `t1` (Jest, provable pre-merge) `| t2` (Playwright against a deployed
build) `| t3` (a manual build-plan row) — set by `bugflow triage`, and read by `bugflow
check`/`bugflow verify` to decide what proof to demand and when. See [DATA-MODEL](./DATA-MODEL.md).

## Verifying

See [Proven vs. done](#proven-vs-done).

## Wave

A greedy colouring of the batch conflict graph — a fixed number of concurrent batches per wave,
chosen so that no two batches sharing one wave also share a non-hub file. In-flight batches are
pre-coloured as wave-1 occupants: never re-offered as a pick, but still holding their conflicts, so
a busy batch's neighbours are correctly pushed to a later wave rather than handed to a second
worker. `bugflow next` returns the head of wave 1. See [PLANNING](./PLANNING.md).

## Witness

The section of the hourly housekeeping Routine (not a separate surface) that checks for expired
leases, missing heartbeats past half the lease, branches with no PR after 24 hours, and failed
runs recorded in an attempts comment — flagging `needs:human` plus a fleet-health comment on the
current wave issue for anything it finds. See [ROADMAP](./ROADMAP.md),
[`templates/routine-housekeeping.md`](../templates/routine-housekeeping.md).
