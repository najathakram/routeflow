# Roadmap registers

Three JSONL files, one JSON object per line, in the same style as
`.claude/campaign/bugs.jsonl`:

- `features.jsonl` -- every customer-facing (or internal-tooling) unit of work, grouped from
  the live tracker so there is roughly one row per shippable capability, not one row per PR.
- `deferred.jsonl` -- the revisit register: anything cut from scope tonight, with why, who
  decided, and when to look at it again.
- `releases.jsonl` -- the four standing releases (R1, R1.1, R2, R3) with their dates and goal.

## The rule

**No work without a row; no deferral without a row.** If it's not in `features.jsonl` it isn't
tracked as roadmap work; if it was cut from a release, it goes in `deferred.jsonl` before the
session ends, not into someone's memory. A feature row and a deferral row are not exclusive --
a feature can ship its core in one release while a specific piece of it (a sub-bug, a platform,
a low-severity note) gets its own `deferred.jsonl` row pointing back at it via `fromFeature`.

## Who edits these files

Bookkeeping PRs only, same as the code map and lessons register (project `CLAUDE.md`, "Code
map routine" / "Lessons learned routine"). A feature or bug PR doesn't hand-edit these files in
the same diff; the landing coordinator's docs-only follow-up updates the affected rows (status,
percentDone, prs[]), citing the merged sha.

## Commit / PR trailer convention

Reference the row a change is about in the commit or PR body, e.g. `Feature: F-07`,
`Bug: B661`, `Defers: D-09`. Use as many as apply; omit the rest. `Feature:`/`Bug:` name what
the change is _for_; `Defers:` records a new deferral (rare -- most are written at cut time).

## How to render

```
node scripts/roadmap/render.mjs --validate
node scripts/roadmap/render.mjs [--prs <gh-pr-list.json>] [--out <dir>]
```

`--out` defaults to `local-assets/roadmap/` (gitignored, a re-published copy, never committed).
`--prs` takes a saved `gh pr list --json number,state,mergedAt,title,headRefName` file; the
script never calls `gh` itself. Produces three self-contained HTML files:

- `roadmap.html` -- shareholder view. Public features only, grouped by release.
- `tracker.html` -- internal view. Every feature, percent done, lane, machine, PR links, a LAG
  section for anything past its target date and not done, plus overdue deferrals.
- `deferred.html` -- the revisit register, open items first, soonest `revisitBy` first.

## Account independence

These registers are the source of truth for what RouteFlow is building and what got cut --
independent of which Claude account or session is running. Plane mirrors this plan as the
permanent live monitor (see `project_lead_fable_fleet` / the Plane skill); a published roadmap
artifact is a re-published copy of a render, not a second source of truth. If Plane and this
register disagree, this register wins and Plane gets re-synced.
