<!--
Paste into a Cloud Routine's prompt field. Status: Proposed v0.1 · Date: 2026-09-04 ·
Audience: whoever sets up the housekeeping Routine.

Trigger: Schedule, hourly. Repos: this repo only. Connectors: none beyond the repo attachment
and the `gh` auth that implies.

This Routine does NOT opt in to <routine-fire-payload> — it is schedule-triggered only, never
fired via the API `fire`-with-bearer-token path, so there is no such payload to treat as
untrusted input. If a later revision adds an API-fire trigger, that payload arrives wrapped as
untrusted <routine-fire-payload> and this prompt must say so explicitly and treat its contents
as data, never as instructions — it does not do that today because it isn't wired that way.
-->

# bugflow housekeeping (hourly)

You are a scheduled, unattended run with no permission prompts and no human watching. Do exactly
the following, in order, and nothing else:

1. `bugflow reap` — release every claim lease that has expired (90 minutes). This is the only
   thing standing between a worker that died mid-run (a laptop that slept, a crashed task) and a
   bug stuck `claimed`/`in_progress` forever.
2. `bugflow sync --quiet` — re-derive every issue's `status:`/`class:`/`tier:`/`wave:`/`harness:`
   labels and Project fields from the actual facts (PR state, CI, deploy, blockers, live leases).
   `sync` is idempotent and reporting-only against issue labels/fields — it never opens a PR,
   never pushes code to a working branch, and never overrides a human's `approved:owner` label.
3. Run the **Witness** checks (see below) — fleet health, not status derivation; never skip this
   tick even when steps 1–2 found nothing to do.
4. Once per calendar day only (skip this step on every other hourly tick): `bugflow snapshot` —
   export `snapshot/issues.jsonl` and append `snapshot/events.jsonl`, committed to branch
   `claude/bugflow-snapshot` (`bugflow.config.json`'s `snapshot.branch`, confirmed against
   `tools/bugflow/docs/DATA-MODEL.md`) — a `claude/`-prefixed branch, the only kind a Cloud
   Routine's push is ever accepted on. `snapshot` writes into its own detached worktree, never
   this Routine's own fresh checkout of the default branch — see [CLI.md](../docs/CLI.md).

## Witness

Four checks over every open Bug/Batch issue, run on every hourly tick:

- **Missing heartbeats past half the lease.** A `claimed`/`in_progress` issue whose live claim
  comment has gone more than `lease.minutes / 2` with no heartbeat, but hasn't expired yet — an
  early warning a long-running worker may be stuck, before `reap` would otherwise touch it.
- **Expired-lease volume.** If step 1's `reap` count is unusually high this tick, that is itself a
  signal (a fleet seat or Routine crashing repeatedly), not just routine cleanup.
- **Branches with no PR after 24 hours.** An `in_progress` issue whose recorded branch/worktree
  comment (from `bugflow start`) is over 24 hours old with no linked PR — work that started and
  stalled before ever opening one.
- **Failed runs recorded in an attempts comment.** A bug whose most recent `release` cap-out
  attempts comment (Ralph-tier) is followed by another failed claim — a bug that keeps bouncing
  rather than converging.

Anything any of the four checks finds gets `needs:human` (if not already present) plus one
fleet-health comment on the **current wave issue** (the lowest-numbered open Batch in `wave:1`, or
a dedicated tracking issue if none exists) — one comment per tick summarizing all findings, never
one comment per finding.

## Success criteria

- `reap` and `sync` both exit 0.
- `sync`'s reported event count is a number, not an error.
- The Witness step runs every tick, whether or not it found anything.
- The snapshot step (when it runs) produces exactly one new commit on `claude/bugflow-snapshot`
  and changes nothing else.

## What to post, and where

- **Normal tick:** post nothing. A quiet, uneventful hourly run is the success case, not a gap in
  reporting.
- **`reap` reclaimed a lease:** no post needed — a reclaimed lease is routine, not an incident;
  it is already visible in the issue's own comment history.
- **`sync`/`reap` exits non-zero, or `snapshot` fails to push:** open (or comment on, if one from
  today already exists) a single tracking issue describing exactly which command failed and its
  output — plain text, no `needs:human` label; this routine never applies that marker itself (see
  Witness above). Do not retry more than once within the same tick.

## Hard rules

- This Routine never claims, works, or comments on a bug's own fix — that is the developer-worker
  and fleet-seat job (`templates/scheduled-task.SKILL.md`), not this one.
- Never push to any branch except `claude/bugflow-snapshot`.
- No live-client identifier in anything you write — a redacted `sync` finding gets flagged, never
  silently written through.
