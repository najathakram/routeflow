# Dashboard

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** whoever sets up the GitHub
Project the first time, anyone looking for "what is everyone working on right now."

GitHub Projects v2 is the dashboard — not a second source of truth. Every field on it mirrors a
label already living on the issue ([DATA-MODEL.md](DATA-MODEL.md)'s Project-fields table); nothing
here is ever hand-edited on the board itself. This doc is the field/view/insights setup, how
`bugflow sync` keeps it in step, and `bugflow render`, the offline fallback for whenever the board
itself is unavailable or the repo is between GitHub sessions.

## Fields

| Field | Type | Mirrors |
| --- | --- | --- |
| Status | single-select (built-in) | `status:*` |
| Wave | number | `wave:N` |
| Class | multi-select (a bug carries 1 `agent-safe`, or 1–3 carve-out classes; never both — see [DATA-MODEL.md](DATA-MODEL.md)) | `class:*` |
| Tier | single-select | `tier:*` |
| Severity | single-select | `severity:*` |
| Area | single-select | `area:*` |
| Harness | single-select | `harness:*` |
| Claimed by | people (built-in) | the issue's assignee |
| Lease expiry | date | the live claim comment's `exp=` field |
| Batch | (built-in parent-issue relationship) | the sub-issue's parent |

`project` in `bugflow.config.json` names the Projects v2 project **number**; `bugflow sync` is
the only writer of any field above, run after every status-affecting fact (see
[LIFECYCLE.md](LIFECYCLE.md)'s ordered check list).

## Views

- **Now** — `status:` in `{claimed, in_progress, in_review, verifying}`, grouped by Claimed by.
  The "what is everyone working on" view — the one a human opens first to avoid duplicating work
  a fleet seat already claimed.
- **Needs you** — `status:parked` (awaiting `approved:owner`), `needs:human` present, or
  `status:regressed`. Everything on this view requires a person, never a worker; it is the
  dashboard's own version of `team.mjs`'s "Needs you" lane (there, driven by a `blocked:owner`
  label on a stuck question — here, the three ways a bug legitimately cannot move without a human
  decision).
- **Board** — grouped by Status, left to right in state-machine order (`triage → ready → claimed →
  in_progress → in_review → verifying → done`, with `blocked`/`parked`/`regressed` as side lanes).
  The literal Kanban view.
- **Waves** — a table grouped by Wave, each row a Batch (or standalone bug) with its Claimed-by,
  Severity and Area columns visible — this is `bugflow plan`'s own output
  ([PLANNING.md](PLANNING.md)) made durable and browsable between planning runs, rather than only
  existing in a command's stdout.
- **Done this week** — `status:done`, filtered on a rolling 7-day window by the item's Status
  field's last-changed timestamp (or, if Projects v2 doesn't expose that directly on a saved view,
  by `closedAt` on the underlying issue — **VERIFY** which is actually filterable at setup time).

## Insights

Two charts, both standard Projects v2 insight chart types against the fields above:

- **Throughput** — a burnup/velocity chart of `status:done` transitions over time (issues closed
  per week), the direct "are we shipping bugs faster than they arrive" signal.
- **Time-in-status** — how long an issue dwells in each `status:` value before moving on,
  aggregated across closed issues. This is the number that tells you whether `verifying` (waiting
  on a deploy) or `in_review` (waiting on merge) is the actual bottleneck, rather than guessing
  from the Board view alone.

## How `sync` mirrors labels onto fields

`gh project item-edit` is the CLI surface for writing a Projects v2 item's field value once you
have the item id and the field id (`gh project field-list`/`item-list` to resolve both). The
mapping is mechanical — one `item-edit --field-id <id> --single-select-option-id <id>` (or
`--number`/`--date`/`--text` per field type) call per changed field, run immediately after `sync`
computes the label side. **VERIFY the exact flag set and whether a single-select's option id needs
re-resolving per project or is stable enough to cache** — this doc states the mechanism precisely
enough to implement against, not the exact command line, per the brief's own instruction to leave
this one for implementation time.

`sync` mirrors **outward only** — labels are the source of truth (per CLAUDE.md's own house rule
for this design: "Labels are the CLI's source of truth; `sync` mirrors them into Project fields").
A field edited by hand directly on the Project board is not read back; the next `sync` run
overwrites it from the labels again. This is deliberate, not an oversight — exactly the same
"derive from facts, never author them" rule the status label itself follows
([LIFECYCLE.md](LIFECYCLE.md)), applied one layer further out.

## `bugflow render [--out <path>]` — the offline fallback

When the Project board isn't the right tool — no network, auditing a point-in-time snapshot,
or GitHub itself is down — `bugflow render` builds a static HTML view from
`snapshot/issues.jsonl` (see [DATA-MODEL.md](DATA-MODEL.md)'s snapshot formats), the same role
`bugs.mjs render` already plays for the current registry: "a projection of the records,
regenerated on demand — so it can never drift, and losing it costs one command." It reads only
the snapshot, never live `gh` calls, so it works from a stale-but-honest snapshot the same way the
current `local-assets/docs/routeflow-bug-registry.html` does — a derived view, disposable,
regenerated rather than hand-maintained, and never treated as more current than the snapshot's own
timestamp. Default output path: `local-assets/bugflow/index.html`, gitignored — nothing this
command writes ever goes under `docs/`.

## Open questions

- Exact `gh project item-edit` flags per field type (single-select vs. number vs. date), and
  whether option ids need re-resolution per call. **VERIFY** at implementation time.
- Whether "Done this week" can filter on a field's last-changed date directly in a saved Projects
  v2 view, or must fall back to the issue's `closedAt`.
- Class is multi-valued (see [DATA-MODEL.md](DATA-MODEL.md)), so its Project field is a
  multi-select; `VERIFY` the exact `item-edit` call shape for a multi-select field, same as the
  flag question above.
