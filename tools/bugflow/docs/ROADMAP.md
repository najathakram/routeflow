# Roadmap

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** whoever decides when to move
bugflow to the next stage, or is scoping the spikes that have to land before Stage 1 starts

Three stages, gated by developer count and load rather than a calendar date, plus the spikes that
have to prove out before Stage 1 can rely on them at all. Each stage names its trigger and what
actually changes, and nothing else — this is a sequencing document, not a design one; the mechanisms
it schedules are specified in [WORKERS.md](WORKERS.md), [HARNESS.md](HARNESS.md) and
[GUARDRAILS.md](GUARDRAILS.md).

## Spikes (run before Stage 1 — each is a pass/fail gate, not a design exercise)

| Spike | Proves | Pass | Fail |
|---|---|---|---|
| **S1** — `gh` auth + push inside a cloud Routine | A Routine can act on GitHub at all | An authenticated `gh api` call succeeds and a commit reaches a `claude/`-prefixed branch; a push attempted at a protected branch is rejected as documented | Auth is silently absent, the `claude/`-branch push never lands, or the protected-branch rejection doesn't happen |
| **S2** — a Desktop task, worktree ON, running the Ralph tier end-to-end on one real agent-safe bug | The developer-worker mapping in [WORKERS.md](WORKERS.md) actually works unattended | Zero permission prompts across `next → claim → brief → (test → fix → gate)×≤8 → PR → prove`; a human confirms the opened PR's `REG-#N` test fails before / passes after the fix | Any prompt blocks the run, the worktree toggle fails to isolate from the human's own checkout, or the loop caps out on a bug picked specifically because it looked trivial |
| **S3** — `gh project item-edit` field mirroring | `sync` can actually drive the Projects v2 dashboard | A custom field (e.g. status) changes via `item-edit` and is visible on the board within the run; running it twice is a no-op, not a duplicate item | Field writes need an interactive `gh project` auth step incompatible with no-prompt operation, or `item-edit` cannot address the field bugflow needs |
| **S4** — merge queue + required checks on the **private** repo | Whether Stage 1's CI story is even possible without a public window | A PR enters the merge queue, required checks run and report on the private repo, and it merges automatically on green | Actions billing blocks checks from running while private (today's known failure), or merge queue is unavailable on the org's plan for a private repo (an open question already flagged in the brief itself) |
| **S5** — comment-CAS between two accounts on two machines | The whole reason bugflow moves off worktree-name identity | Two accounts race a claim within the lease's jitter window; exactly one wins (lowest comment id), the loser sees exit 3 and its `<!--bugflow:release … reason=lost-race-->` comment actually frees the issue for a third claimant | Both accounts believe they won, or the loser's release doesn't free the issue |

## Stage 1 — now → 5 developers

**Trigger:** today; this is the bootstrap.

- GitHub Issues as the database (issue type Bug, labels, sub-issues/parent for batches, native
  blocked-by/blocking).
- Labels and Project fields wired per [DATA-MODEL.md](DATA-MODEL.md); `sync` mirrors labels →
  fields.
- The Desktop scheduled-task template
  ([`../templates/scheduled-task.SKILL.md`](../templates/scheduled-task.SKILL.md)) in real use on at
  least one developer machine.
- The housekeeping cloud Routine live (hourly `reap` + `sync`).
- The Ralph tier operating end-to-end (post-S2).
- **Fix Actions billing on the private repo** — a hard prerequisite for everything CI-shaped later
  (merge queue, required checks, the proof gate as a required check); see
  [GUARDRAILS.md](GUARDRAILS.md).
- A Projects v2 board wired to the labels (post-S3).

## Stage 2 — thousands of users / 5–15 developers

**Trigger:** the bug inflow starts to exceed what triage-by-hand can keep up with, or the developer
count makes a single shared board noisy.

- Error monitoring with fingerprints auto-filing `source:monitor` issues — GlitchTip or a
  self-hosted Sentry (`VERIFY:` which; the brief names both as options, not a decision).
- The nightly triage Routine goes live for real (was hand-run or absent in Stage 1).
- Severity SLAs (a `severity:critical` bug ages into escalation on a clock).
- CODEOWNERS grows real per-area entries (`area:` labels already exist from Stage 1; this is where
  they start gating reviews).
- First fleet seat (dedicated Team seat, either Desktop-5-min or Routine-hourly per
  [WORKERS.md](WORKERS.md)).
- Merge queue turns on for real (post-S4, and post-Actions-billing-fix).
- The **Witness** checks (expired leases, missing heartbeats past half the lease, branches with no
  PR after 24 hours, failed runs from attempts comments) graduate from a section of the hourly
  housekeeping Routine (Stage 1) to their own named, separately monitored Routine — same four
  checks, just split out once housekeeping's single run starts taking too long to also cover them.

## Stage 3 — 15+ developers

**Trigger:** one repo's Project board stops being the right unit, or one fleet seat's throughput
stops being enough.

- Org-level Project (spanning repos, not just this one).
- N fleet seats (plural — the capacity formula in [WORKERS.md](WORKERS.md) scales linearly here).
- Per-area rulesets, not one blanket ruleset for the whole repo.
- Enterprise managed settings (centrally enforced, not per-repo convention).
- Metrics derived from `snapshot` history (`bugflow snapshot`'s `events.jsonl` becomes a real time
  series worth graphing, not just an audit trail).
- Channels (research preview) for event push into a running session, rather than everything being
  poll/schedule-driven.

## Capacity knobs (what actually moves between stages)

`seats.<login>.dailyClaimCap` · `harness.ralph.maxIterations` (8) · `batch.maxBugs` (4) ·
`lease.minutes` (90) · fleet-seat count · the Routine schedule floor (1 hour, a platform constant,
not a knob). None of these move on anything but ledger evidence, per the pipeline law's ten-run rule
(see [HARNESS.md](HARNESS.md)) — this roadmap sequences **when** a knob is even reachable (e.g., a
second fleet seat is meaningless before Stage 2), never what value it should take.

## Non-goals

- **No custom database, dashboard, or auth system.** GitHub Issues + Projects v2 already are both; a
  bespoke one duplicates a maintained platform for no gain.
- **No API bots.** No Claude API key, no Agent SDK, no GitHub-Actions-hosted agent — subscription
  seats only, at every stage, per [WORKERS.md](WORKERS.md).
- **No Gas-Town-style central orchestrator.** Bugflow is pull-based (`next`/`claim`/lease)
  precisely so no central control plane pushes work at workers or has to know they exist.
- **No OpenHands, no SWE-agent.** Claude Code is the only execution substrate at every stage; a
  second agent framework is a second set of guardrails to build and maintain for no throughput this
  design doesn't already get from more seats.

## Open questions

- `VERIFY:` GlitchTip vs self-hosted Sentry for Stage 2 error monitoring.
- `VERIFY:` merge queue's plan requirement on a private repo (also flagged in
  [GUARDRAILS.md](GUARDRAILS.md); S4 is the spike that answers it directly).
